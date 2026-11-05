"""Decisions reported to the gate's audit plane, in batches, off the request path.

Bounded: at most 500 wait, and when full the oldest is dropped and counted. A report lost to an
outage is lost; the gate's enforcement-status plane is where an outage shows.

Each report is sent under the key of the site it is about, so on a multi-site platform a batch is
split by key: a report never reaches the gate under another writer's key.
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

from naulon._log import warn_error, warn_once
from naulon.sites import Site

BATCH = 50
FLUSH_S = 5.0
MAX_QUEUED = 500


class ObservationQueue:
    def __init__(
        self,
        send: Callable[[Site | None, list[dict[str, Any]]], bool],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._send = send
        self._clock = clock
        self._items: deque[tuple[Site | None, dict[str, Any]]] = deque()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._worker: threading.Thread | None = None
        self._pid = os.getpid()
        self.dropped = 0
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._after_fork)

    def _after_fork(self) -> None:
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._worker = None
        self._pid = os.getpid()

    def put(self, obs: dict[str, Any], site: Site | None = None) -> None:
        with self._lock:
            if len(self._items) >= MAX_QUEUED:
                self._items.popleft()
                self.dropped += 1
            self._items.append((site, obs))
            full = len(self._items) >= BATCH
        self._ensure_worker()
        if full:
            self._wake.set()

    def queued(self) -> list[dict[str, Any]]:
        """The reports waiting to be sent, oldest first, without their keys."""
        with self._lock:
            return [obs for _, obs in self._items]

    def flush(self) -> int:
        """Send what is queued, BATCH at a time, on this thread. Returns how many were sent."""
        sent = 0
        while True:
            with self._lock:
                batch = [self._items.popleft() for _ in range(min(BATCH, len(self._items)))]
            if not batch:
                return sent
            # One batch per site: a report is sent under the credential of the site it is about.
            groups: dict[Site | None, list[dict[str, Any]]] = {}
            for site, obs in batch:
                groups.setdefault(site, []).append(obs)
            for site, reports in groups.items():
                try:
                    ok = self._send(site, reports)
                except Exception:
                    ok = False
                if not ok:
                    warn_once(
                        "observe.send", "naulon: %d decision reports could not be sent and were dropped", len(reports)
                    )
                    return sent
                sent += len(reports)

    def _ensure_worker(self) -> None:
        if self._pid != os.getpid():
            self._after_fork()
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._run, name="naulon-observe", daemon=True)
            self._worker.start()

    def _run(self) -> None:
        while True:
            self._wake.wait(FLUSH_S)
            self._wake.clear()
            try:
                self.flush()
            except Exception as err:
                warn_error("observe.worker", "naulon: report flush failed", err)
