from __future__ import annotations

import time
from typing import Any

from naulon.observe import MAX_QUEUED, ObservationQueue


def test_fifty_reports_go_in_one_post() -> None:
    batches: list[list[dict[str, Any]]] = []
    q = ObservationQueue(lambda b: batches.append(b) or True)
    for i in range(50):
        q.put({"i": i})
    deadline = time.monotonic() + 2
    while not batches and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(batches) == 1 and len(batches[0]) == 50


def test_overflow_drops_the_oldest_and_counts_it() -> None:
    q = ObservationQueue(lambda b: False)
    q._ensure_worker = lambda: None  # type: ignore[method-assign]
    for i in range(MAX_QUEUED + 7):
        q.put({"i": i})
    assert q.dropped == 7
    assert list(q._items)[0] == {"i": 7}


def test_a_send_that_raises_never_escapes() -> None:
    def boom(batch: list[dict[str, Any]]) -> bool:
        raise RuntimeError("down")

    q = ObservationQueue(boom)
    q._ensure_worker = lambda: None  # type: ignore[method-assign]
    q.put({"i": 1})
    assert q.flush() == 0
