"""The policy per host, kept fresh in a background thread so no request ever waits for it.

`get` never blocks: it answers what is cached and asks the worker to refresh what is missing or old.
Before the first good copy arrives, a host has no policy and every request to it is served. A failed
refresh keeps the last good copy. The worker starts on first use in each process, so a server that
forks after import (gunicorn's pre-fork model) gets a live worker in every child.
"""

from __future__ import annotations

import collections
import hashlib
import json
import os
import threading
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from naulon import ranges
from naulon._log import warn_error, warn_once
from naulon.settings import Settings
from naulon.transport import Breaker, Transport

RANGES_PATH = "/.well-known/naulon/crawler-ranges.json"
RANGES_REFRESH_S = 21_600.0
# A gate may publish no ranges at all (a self-hosted one without them answers 503), so a failed
# fetch is retried slowly and never counts against the circuit breaker.
RANGES_RETRY_S = 600.0
# How soon to ask again after a failure when nothing good is cached yet.
RETRY_S = 60.0
_RANGES_KEY = "\x00ranges"
# Host headers are the caller's to write. At most this many hosts without a policy are remembered,
# and at most this many fetches wait in the queue; a host with a good policy is never evicted.
MAX_UNKNOWN_HOSTS = 10_000
MAX_QUEUED = 1_000


@dataclass
class _Entry:
    doc: dict[str, Any] | None
    fetched_at: float
    scheme: str
    host: str
    key: str | None = field(default=None, repr=False)
    pending: bool = False


def key_digest(key: str | None) -> str:
    """A short, stable name for a key, so caches can be keyed by it without holding it twice."""
    return hashlib.sha256(key.encode()).hexdigest()[:24] if key else ""


def _entry_id(host: str, key: str | None) -> str:
    # One policy per host AND key: on a platform two writers' keys never share an answer, and a key
    # the gate refused for one host never decides another.
    return f"{host.lower()}\x00{key_digest(key)}"


class ConfigCache:
    def __init__(
        self,
        settings: Settings,
        transport: Transport,
        breaker: Breaker,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._breaker = breaker
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}
        self._ranges: ranges.Compiled | None = None
        self._ranges_at: float | None = None
        self._ranges_pending = False
        self._wake = threading.Condition(self._lock)
        # Two lanes. Hosts that hold a policy (and the ranges) refresh first, in order. Hosts without
        # one wait newest-first in a bounded lane: a flood of made-up hosts pushes the oldest out, and
        # a real host asked for again moves back to the front, so it is never starved.
        self._known: collections.deque[str] = collections.deque()
        self._unknown: collections.OrderedDict[str, None] = collections.OrderedDict()
        self._worker: threading.Thread | None = None
        self._pid = os.getpid()
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._after_fork)

    def _after_fork(self) -> None:
        # A child inherits the parent's dict but not its thread. Start over, keeping what was cached.
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._known = collections.deque()
        self._unknown = collections.OrderedDict()
        self._worker = None
        self._pid = os.getpid()
        for e in self._entries.values():
            e.pending = False
        self._ranges_pending = False

    def get(self, host: str, scheme: str = "https", site_key: str | None = None) -> dict[str, Any] | None:
        """The cached policy for `host` under `site_key`, or None. Never blocks; schedules a refresh
        when due."""
        key = _entry_id(host, site_key)
        now = self._clock()
        with self._lock:
            e = self._entries.get(key)
            if e is None:
                if len(self._entries) >= MAX_UNKNOWN_HOSTS:
                    self._evict_unknown()
                e = _Entry(doc=None, fetched_at=float("-inf"), scheme=scheme, host=host.lower(), key=site_key)
                self._entries[key] = e
            due = not e.pending and now - e.fetched_at >= self._settings.refresh_s
            if due:
                e.pending = True
                self._push(key, known=e.doc is not None)
            elif e.pending and key in self._unknown:
                self._unknown.move_to_end(key)  # asked again: back to the front of its lane
            doc = e.doc
        if due:
            self._ensure_worker()
        self._ranges_due(now)
        return doc

    def _push(self, key: str, known: bool) -> None:
        """Queue a fetch. Called with the lock held."""
        if known:
            self._known.append(key)
        else:
            self._unknown[key] = None
            self._unknown.move_to_end(key)
            while len(self._unknown) > MAX_QUEUED:
                dropped, _ = self._unknown.popitem(last=False)
                gone = self._entries.get(dropped)
                if gone is not None:
                    gone.pending = False  # a later request queues it again
        self._wake.notify()

    def _pop(self) -> str:
        with self._lock:
            while not self._known and not self._unknown:
                self._wake.wait()
            if self._known:
                return self._known.popleft()
            key, _ = self._unknown.popitem(last=True)
            return key

    def queued(self) -> int:
        with self._lock:
            return len(self._known) + len(self._unknown)

    def _evict_unknown(self) -> None:
        """Drop the oldest half of the hosts that hold no policy. Called with the lock held. A host
        with a good policy is never dropped: losing it would serve its agents free."""
        unknown = [k for k, e in self._entries.items() if e.doc is None and not e.pending]
        for k in unknown[: max(1, len(unknown) // 2)]:
            del self._entries[k]

    def ranges(self) -> ranges.Compiled | None:
        return self._ranges

    def _ranges_due(self, now: float) -> None:
        with self._lock:
            due = not self._ranges_pending and (self._ranges_at is None or now - self._ranges_at >= RANGES_REFRESH_S)
            if due:
                self._ranges_pending = True
                self._push(_RANGES_KEY, known=True)
        if due:
            self._ensure_worker()

    def _ensure_worker(self) -> None:
        if self._pid != os.getpid():
            self._after_fork()
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._run, name="naulon-config", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        while True:
            key = self._pop()
            try:
                if key == _RANGES_KEY:
                    self._refresh_ranges()
                else:
                    self._refresh_entry(key)
            except Exception as err:  # the worker must outlive any one bad answer
                warn_error("config.worker", "naulon: config refresh failed", err)

    def refresh_now(self, host: str, site_key: str | None = None) -> None:
        """Fetch `host`'s policy under `site_key` now, on this thread. A test may call it."""
        key = _entry_id(host, site_key)
        with self._lock:
            self._entries.setdefault(
                key, _Entry(doc=None, fetched_at=float("-inf"), scheme="https", host=host.lower(), key=site_key)
            )
        self._refresh_entry(key)

    def _refresh_entry(self, key: str) -> None:
        with self._lock:
            e = self._entries.get(key)
            if e is None:  # evicted while queued
                return
            scheme, host, site_key = e.scheme, e.host, e.key
        outcome = self._fetch(host, scheme, site_key)
        now = self._clock()
        with self._lock:
            e = self._entries.setdefault(
                key, _Entry(doc=None, fetched_at=float("-inf"), scheme=scheme, host=host, key=site_key)
            )
            e.pending = False
            if isinstance(outcome, str):
                # Keep the last good copy, and ask again in a minute rather than a full interval.
                e.fetched_at = now - self._settings.refresh_s + RETRY_S
                return
            e.doc = outcome
            e.fetched_at = now

    def _fetch(self, host: str, scheme: str, site_key: str | None) -> dict[str, Any] | None | str:
        """The document, None for "no publisher here", or "failed" for no usable answer."""
        gate = self._settings.gate
        if gate is None or not self._breaker.allow():
            return "failed"
        resource = urllib.parse.quote(f"{scheme}://{host}/", safe="")
        res = self._transport.request(
            "GET",
            f"{gate}/_naulon/enforce-config?resource={resource}",
            headers=_auth(site_key),
            body=None,
            timeout=max(self._settings.timeout, 5.0),
        )
        if res is None or res.status >= 500:
            self._breaker.record(False)
            warn_once("config.unreachable", "naulon: the gate did not answer enforce-config; serving every request")
            return "failed"
        self._breaker.record(True)
        if res.status in (401, 403, 404):
            # 403 and 404 mean the gate tolls no site at this host, which is normal for a host that has
            # not turned naulon on. Only 401 says the key itself is wrong.
            if res.status == 401:
                warn_once("config.401", "naulon: the gate refused a site key (HTTP 401); that site is not tolled")
            return None
        if res.status != 200:
            return "failed"
        try:
            doc = json.loads(res.body)
        except ValueError:
            return "failed"
        if not isinstance(doc, dict) or not isinstance(doc.get("enforcement"), dict):
            return "failed"
        return doc

    def _refresh_ranges(self) -> None:
        gate = self._settings.gate
        compiled = None
        if gate is not None:
            # Off the breaker on purpose: the ranges are optional, and their 503 says nothing about
            # whether the gate can price or settle. Counted, it held the breaker open for good.
            res = self._transport.request("GET", f"{gate}{RANGES_PATH}", headers={}, body=None, timeout=10.0)
            if res is not None and res.status == 200:
                try:
                    valid = ranges.validate(json.loads(res.body))
                    compiled = ranges.compile_doc(valid) if valid is not None else None
                except ValueError:
                    compiled = None
        with self._lock:
            self._ranges_pending = False
            now = self._clock()
            if compiled is not None:
                self._ranges = compiled
                self._ranges_at = now
            else:
                # Keep the last good copy, and ask again in ten minutes rather than six hours.
                self._ranges_at = now - RANGES_REFRESH_S + RANGES_RETRY_S


def _auth(site_key: str | None) -> dict[str, str]:
    h = {"accept": "application/json", "user-agent": "naulon-python"}
    if site_key:
        h["authorization"] = f"Bearer {site_key}"
    return h
