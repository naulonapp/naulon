from __future__ import annotations

import os
import threading
import time

import pytest
from conftest import FakeTransport, config_doc, json_response

from naulon.config import ConfigCache
from naulon.settings import Settings
from naulon.transport import Breaker, Response

S = Settings(gate="http://gate", key="k")


def cache(t: FakeTransport, now: list[float] | None = None) -> ConfigCache:
    clock = (lambda: now[0]) if now is not None else time.monotonic
    return ConfigCache(S, t, Breaker(), clock=clock)


def wait_for(cond: object, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if callable(cond) and cond():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met")


def test_first_get_returns_none_and_schedules_one_fetch() -> None:
    t = FakeTransport({"/_naulon/enforce-config": json_response(200, config_doc())})
    c = cache(t)
    assert c.get("blog.test") is None
    wait_for(lambda: c.get("blog.test") is not None)
    assert t.paths().count("/_naulon/enforce-config") == 1


def test_concurrent_gets_for_one_host_schedule_one_fetch() -> None:
    gate_open = threading.Event()

    def slow(method: str, url: str, body: bytes | None) -> Response:
        gate_open.wait(2)
        return json_response(200, config_doc())

    t = FakeTransport({"/_naulon/enforce-config": slow})
    c = cache(t)
    threads = [threading.Thread(target=c.get, args=("blog.test",)) for _ in range(20)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    gate_open.set()
    wait_for(lambda: c.get("blog.test") is not None)
    assert t.paths().count("/_naulon/enforce-config") == 1


def test_a_failed_refresh_keeps_the_last_good_document() -> None:
    now = [0.0]
    t = FakeTransport({"/_naulon/enforce-config": json_response(200, config_doc())})
    c = cache(t, now)
    c.refresh_now("blog.test")
    t.routes["/_naulon/enforce-config"] = None
    now[0] = 1000
    c.refresh_now("blog.test")
    t.routes["/_naulon/enforce-config"] = json_response(500, {})
    c.refresh_now("blog.test")
    t.routes["/_naulon/enforce-config"] = Response(200, {}, b"not json")
    c.refresh_now("blog.test")
    assert c.get("blog.test") == config_doc()


def test_a_404_caches_no_publisher_for_the_refresh_interval() -> None:
    now = [0.0]
    t = FakeTransport({"/_naulon/enforce-config": json_response(404, {"error": "unknown host"})})
    c = cache(t, now)
    c.refresh_now("off.test")
    for _ in range(50):
        assert c.get("off.test") is None
    time.sleep(0.05)
    assert t.paths().count("/_naulon/enforce-config") == 1, "a disabled blog costs one fetch per interval"


def test_host_keys_ignore_case() -> None:
    t = FakeTransport({"/_naulon/enforce-config": json_response(200, config_doc())})
    c = cache(t)
    c.refresh_now("Test.LocalHost:8600")
    assert c.get("test.localhost:8600") == config_doc()


def test_the_worker_starts_on_first_use_once_per_process() -> None:
    t = FakeTransport({"/_naulon/enforce-config": json_response(200, config_doc())})
    c = cache(t)
    assert c._worker is None, "nothing runs at import or construction"
    c.get("a.test")
    first = c._worker
    c.get("b.test")
    assert first is not None and c._worker is first


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs fork")
def test_after_fork_the_child_starts_its_own_worker() -> None:
    t = FakeTransport({"/_naulon/enforce-config": json_response(200, config_doc())})
    c = cache(t)
    c.get("a.test")
    wait_for(lambda: c.get("a.test") is not None)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:  # child
        ok = c._worker is None and c.get("a.test") == config_doc()
        c.get("b.test")
        ok = ok and c._worker is not None and c._worker.is_alive()
        os.write(w, b"1" if ok else b"0")
        os._exit(0)
    os.close(w)
    got = os.read(r, 1)
    os.waitpid(pid, 0)
    assert got == b"1"


def test_ranges_are_fetched_in_the_background_and_a_bad_document_is_ignored() -> None:
    t = FakeTransport(
        {
            "/_naulon/enforce-config": json_response(200, config_doc()),
            "/.well-known/naulon/crawler-ranges.json": json_response(
                200, {"version": 1, "generatedAt": "x", "operators": [], "proxies": {"cf": ["0.0.0.0/0"]}}
            ),
        }
    )
    c = cache(t)
    c.get("a.test")
    wait_for(lambda: "/.well-known/naulon/crawler-ranges.json" in t.paths())
    time.sleep(0.05)
    assert c.ranges() is None, "a /0 refuses the whole document"


def test_a_gate_without_ranges_never_opens_the_breaker() -> None:
    t = FakeTransport({"/.well-known/naulon/crawler-ranges.json": Response(503, {}, b"")})
    b = Breaker(threshold=5)
    c = ConfigCache(S, t, b)
    for _ in range(20):
        c._refresh_ranges()
    assert b.allow(), "an optional document's 503 is not a gate failure"
