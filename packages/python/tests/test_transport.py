from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from naulon.transport import Breaker, UrllibTransport


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/slow":
            time.sleep(1.0)
        if self.path == "/boom":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error":"boom"}')
            return
        if self.path == "/away":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.2:9/steal")
            self.end_headers()
            return
        if self.path == "/here":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def server() -> Iterator[str]:
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_a_timeout_returns_none(server: str) -> None:
    assert UrllibTransport().request("GET", f"{server}/slow", headers={}, body=None, timeout=0.2) is None


def test_a_dns_failure_returns_none() -> None:
    assert UrllibTransport().request("GET", "http://naulon-test.invalid/", headers={}, body=None, timeout=2) is None


def test_a_500_is_a_response(server: str) -> None:
    res = UrllibTransport().request("GET", f"{server}/boom", headers={}, body=None, timeout=2)
    assert res is not None and res.status == 500 and res.body == b'{"error":"boom"}'


def test_a_redirect_to_another_host_is_never_followed(server: str) -> None:
    res = UrllibTransport().request(
        "GET", f"{server}/away", headers={"authorization": "Bearer k"}, body=None, timeout=2
    )
    assert res is not None and res.status == 302


def test_a_redirect_on_the_same_host_is_followed(server: str) -> None:
    res = UrllibTransport().request("GET", f"{server}/here", headers={}, body=None, timeout=2)
    assert res is not None and res.status == 200 and res.body == b"ok"


def test_the_breaker_opens_after_five_failures_and_probes_after_the_cooldown() -> None:
    now = [0.0]
    b = Breaker(threshold=5, cooldown_s=60, clock=lambda: now[0])
    for _ in range(5):
        assert b.allow()
        b.record(False)
    assert not b.allow()
    now[0] = 59
    assert not b.allow()
    now[0] = 61
    assert b.allow(), "one probe after the cooldown"
    assert not b.allow(), "and only one"
    b.record(True)
    assert b.allow()


def test_a_failed_probe_reopens_it() -> None:
    now = [0.0]
    b = Breaker(threshold=5, cooldown_s=60, clock=lambda: now[0])
    for _ in range(5):
        b.record(False)
    now[0] = 61
    assert b.allow()
    b.record(False)
    assert not b.allow()
