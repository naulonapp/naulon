"""The policy per host, kept fresh in a background thread so no request ever waits for it.

`get` never blocks: it answers what is cached and asks the worker to refresh what is missing or old.
Before the first good copy arrives, a host has no policy and every request to it is served. A failed
refresh keeps the last good copy. The worker starts on first use in each process, so a server that
forks after import (gunicorn's pre-fork model) gets a live worker in every child.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from naulon import ranges
from naulon._log import warn_once
from naulon.settings import Settings
from naulon.transport import Breaker, Transport

RANGES_PATH = "/.well-known/naulon/crawler-ranges.json"
RANGES_REFRESH_S = 21_600.0
# How soon to ask again after a failure when nothing good is cached yet.
RETRY_S = 60.0
_RANGES_KEY = "\x00ranges"


@dataclass
class _Entry:
    doc: dict[str, Any] | None
    fetched_at: float
    scheme: str
    pending: bool = False


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
        self._queue: queue.SimpleQueue[str] = queue.SimpleQueue()
        self._worker: threading.Thread | None = None
        self._pid = os.getpid()
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._after_fork)

    def _after_fork(self) -> None:
        # A child inherits the parent's dict but not its thread. Start over, keeping what was cached.
        self._lock = threading.Lock()
        self._queue = queue.SimpleQueue()
        self._worker = None
        self._pid = os.getpid()
        for e in self._entries.values():
            e.pending = False
        self._ranges_pending = False

    def get(self, host: str, scheme: str = "https") -> dict[str, Any] | None:
        """The cached policy for `host`, or None. Never blocks; schedules a refresh when due."""
        key = host.lower()
        now = self._clock()
        with self._lock:
            e = self._entries.get(key)
            if e is None:
                e = _Entry(doc=None, fetched_at=float("-inf"), scheme=scheme)
                self._entries[key] = e
                if len(self._entries) > 10_000:
                    # A host header is the caller's to write. Bound the table rather than grow it.
                    self._entries = {key: e}
            due = not e.pending and now - e.fetched_at >= self._settings.refresh_s
            if due:
                e.pending = True
            doc = e.doc
        if due:
            self._enqueue(key)
        self._ranges_due(now)
        return doc

    def ranges(self) -> ranges.Compiled | None:
        return self._ranges

    def _ranges_due(self, now: float) -> None:
        with self._lock:
            due = not self._ranges_pending and (self._ranges_at is None or now - self._ranges_at >= RANGES_REFRESH_S)
            if due:
                self._ranges_pending = True
        if due:
            self._enqueue(_RANGES_KEY)

    def _enqueue(self, key: str) -> None:
        self._ensure_worker()
        self._queue.put(key)

    def _ensure_worker(self) -> None:
        if self._pid != os.getpid():
            self._after_fork()
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._run, name="naulon-config", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        q = self._queue
        while True:
            key = q.get()
            try:
                if key == _RANGES_KEY:
                    self._refresh_ranges()
                else:
                    self.refresh_now(key)
            except Exception as err:  # the worker must outlive any one bad answer
                warn_once("config.worker", "naulon: config refresh failed (%s)", type(err).__name__)

    def refresh_now(self, host: str) -> None:
        """Fetch `host`'s policy now, on this thread. The worker calls it; so may a test."""
        key = host.lower()
        with self._lock:
            e = self._entries.setdefault(key, _Entry(doc=None, fetched_at=float("-inf"), scheme="https"))
            scheme = e.scheme
        outcome = self._fetch(key, scheme)
        now = self._clock()
        with self._lock:
            e = self._entries.setdefault(key, _Entry(doc=None, fetched_at=float("-inf"), scheme=scheme))
            e.pending = False
            if isinstance(outcome, str):
                # Keep the last good copy, and ask again in a minute rather than a full interval.
                e.fetched_at = now - self._settings.refresh_s + RETRY_S
                return
            e.doc = outcome
            e.fetched_at = now

    def _fetch(self, host: str, scheme: str) -> dict[str, Any] | None | str:
        """The document, None for "no publisher here", or "failed" for no usable answer."""
        gate = self._settings.gate
        if gate is None or not self._breaker.allow():
            return "failed"
        resource = urllib.parse.quote(f"{scheme}://{host}/", safe="")
        res = self._transport.request(
            "GET",
            f"{gate}/_naulon/enforce-config?resource={resource}",
            headers=_auth(self._settings),
            body=None,
            timeout=max(self._settings.timeout, 5.0),
        )
        if res is None or res.status >= 500:
            self._breaker.record(False)
            warn_once("config.unreachable", "naulon: the gate did not answer enforce-config; serving every request")
            return "failed"
        self._breaker.record(True)
        if res.status in (401, 403, 404):
            if res.status != 404:
                warn_once(
                    f"config.{res.status}", "naulon: the gate refused this key for %s (HTTP %d)", host, res.status
                )
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
        if gate is not None and self._breaker.allow():
            res = self._transport.request("GET", f"{gate}{RANGES_PATH}", headers={}, body=None, timeout=10.0)
            self._breaker.record(res is not None and res.status < 500)
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
                # Keep the last good copy, and ask again in a minute rather than six hours.
                self._ranges_at = now - RANGES_REFRESH_S + RETRY_S


def _auth(s: Settings) -> dict[str, str]:
    h = {"accept": "application/json", "user-agent": "naulon-python"}
    if s.key:
        h["authorization"] = f"Bearer {s.key}"
    return h
