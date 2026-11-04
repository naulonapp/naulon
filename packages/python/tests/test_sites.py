"""A platform hosting many sites: each request is tolled under its own site's key, or not at all."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest
from conftest import AGENT_UA, BROWSER_UA, FakeTransport, config_doc, gate, json_response
from test_wsgi import App, environ, run

from naulon.adapters.asgi import NaulonASGI
from naulon.adapters.wsgi import NaulonWSGI
from naulon.core import Naulon
from naulon.settings import Settings
from naulon.sites import SiteKeys
from naulon.transport import Response

KEYS = {"alice.blog.test": "nln_alice", "bob.blog.test": "nln_bob"}


class Recording(FakeTransport):
    """A gate that remembers which key each call carried."""

    def __init__(self, routes: Mapping[str, Any] | None = None) -> None:
        super().__init__(routes)
        self.auth: list[tuple[str, str | None]] = []

    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response | None:
        path = "/" + url.split("://", 1)[1].split("/", 1)[1].split("?", 1)[0]
        self.auth.append((path, headers.get("authorization")))
        return super().request(method, url, headers=headers, body=body, timeout=timeout)


def recording_gate() -> Recording:
    t = Recording()
    t.routes = dict(gate().routes)
    return t


def engine(t: FakeTransport, key: str | None = None) -> Naulon:
    n = Naulon(Settings(gate="http://gate", key=key), transport=t)
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config._ensure_worker = lambda: None  # type: ignore[method-assign]
    return n


def warm(n: Naulon, t: FakeTransport) -> None:
    for host, key in KEYS.items():
        n.config.refresh_now(host, key)
    n.config._refresh_ranges()
    t.calls.clear()
    if isinstance(t, Recording):
        t.auth.clear()


def agent_on(host: str) -> dict[str, Any]:
    return environ(AGENT_UA, HTTP_HOST=host)


# ── which key, if any ──────────────────────────────────────────────────────────────────────────


def test_a_site_without_a_key_is_never_touched() -> None:
    t = recording_gate()
    n = engine(t)
    mw = NaulonWSGI(App([b"<p>a</p>"]), naulon=n, key_for=KEYS.get)
    status, _, body = run(mw, agent_on("carol.blog.test"))
    assert status.startswith("200") and body == b"<p>a</p>"
    assert t.calls == [], "no key: not one call to the gate"


def test_no_key_never_falls_back_to_the_global_key() -> None:
    t = recording_gate()
    n = engine(t, key="nln_global")
    # The global key HAS a charging policy for this host, so a fallback would answer 402.
    n.config.refresh_now("alice.blog.test", "nln_global")
    n.config._refresh_ranges()
    t.calls.clear()
    mw = NaulonWSGI(App([b"<p>a</p>"]), settings=n.settings, naulon=n, key_for=lambda host: None)
    status, _, _ = run(mw, agent_on("alice.blog.test"))
    assert status.startswith("200") and t.calls == []


def test_each_site_is_tolled_under_its_own_key() -> None:
    t = recording_gate()
    n = engine(t)
    warm(n, t)
    mw = NaulonWSGI(App([b"<p>a</p>"]), naulon=n, key_for=KEYS.get)
    a, _, _ = run(mw, agent_on("alice.blog.test"))
    b, _, _ = run(mw, agent_on("bob.blog.test"))
    assert a.startswith("402") and b.startswith("402")
    quotes = [auth for path, auth in t.auth if path == "/_naulon/quote"]
    assert quotes == ["Bearer nln_alice", "Bearer nln_bob"]


def test_a_person_on_a_keyed_site_is_untouched() -> None:
    t = recording_gate()
    n = engine(t)
    warm(n, t)
    mw = NaulonWSGI(App([b"<p>a</p>"]), naulon=n, key_for=KEYS.get)
    status, _, body = run(mw, environ(BROWSER_UA, HTTP_HOST="alice.blog.test"))
    assert status.startswith("200") and body == b"<p>a</p>" and t.calls == []


# ── no answer is shared across keys ────────────────────────────────────────────────────────────


def test_one_host_under_two_keys_holds_two_policies() -> None:
    def by_key(method: str, url: str, body: bytes | None) -> Response:
        raise AssertionError("routed by headers below")

    seen: list[str | None] = []

    class PerKey(FakeTransport):
        def request(self, method, url, *, headers, body, timeout):  # type: ignore[no-untyped-def]
            seen.append(headers.get("authorization"))
            mode = "observe" if headers.get("authorization") == "Bearer nln_alice" else "charge"
            return json_response(200, config_doc(tollMode=mode))

    n = engine(PerKey())
    n.config.refresh_now("shared.test", "nln_alice")
    n.config.refresh_now("shared.test", "nln_bob")
    a = n.config.get("shared.test", "https", "nln_alice")
    b = n.config.get("shared.test", "https", "nln_bob")
    assert a is not None and b is not None
    assert a["rules"]["tollMode"] == "observe" and b["rules"]["tollMode"] == "charge"
    assert seen == ["Bearer nln_alice", "Bearer nln_bob"]


def test_a_cached_quote_is_never_served_under_another_key() -> None:
    t = recording_gate()
    n = engine(t)
    n.client.quote("https://shared.test/x/", "/x/", "read", site_key="nln_alice")
    n.client.quote("https://shared.test/x/", "/x/", "read", site_key="nln_bob")
    n.client.quote("https://shared.test/x/", "/x/", "read", site_key="nln_alice")  # cached
    quotes = [auth for path, auth in t.auth if path == "/_naulon/quote"]
    assert quotes == ["Bearer nln_alice", "Bearer nln_bob"]


def test_reports_are_sent_under_the_key_of_the_site_they_describe() -> None:
    sent: list[tuple[str | None, int]] = []
    n = engine(gate())
    n.observations._send = lambda key, batch: sent.append((key, len(batch))) or True  # type: ignore[assignment]
    n.observations.put({"i": 1}, "nln_alice")
    n.observations.put({"i": 2}, "nln_bob")
    n.observations.put({"i": 3}, "nln_alice")
    assert n.observations.flush() == 3
    assert sorted(sent) == [("nln_alice", 2), ("nln_bob", 1)]


# ── the platform's lookup ──────────────────────────────────────────────────────────────────────


def test_the_lookup_runs_once_per_host_per_interval() -> None:
    now = [0.0]
    asked: list[str] = []

    def key_for(host: str) -> str | None:
        asked.append(host)
        return KEYS.get(host)

    sites = SiteKeys(None, key_for, ttl_s=30.0, clock=lambda: now[0])
    for _ in range(5):
        assert sites.key("Alice.Blog.Test") == "nln_alice"
    assert asked == ["alice.blog.test"]
    now[0] = 31.0
    sites.key("alice.blog.test")
    assert asked == ["alice.blog.test", "alice.blog.test"], "a changed or revoked key lands within the interval"


def test_a_lookup_that_raises_serves_the_page() -> None:
    t = recording_gate()

    def broken(host: str) -> str | None:
        raise RuntimeError("database down")

    mw = NaulonWSGI(App([b"<p>a</p>"]), naulon=engine(t), key_for=broken)
    status, _, body = run(mw, agent_on("alice.blog.test"))
    assert status.startswith("200") and body == b"<p>a</p>" and t.calls == []


@pytest.mark.parametrize("junk", ["", "   ", 7, b"nln_alice"])
def test_a_key_that_is_not_text_counts_as_none(junk: object) -> None:
    sites = SiteKeys(None, lambda host: junk)  # type: ignore[arg-type,return-value]
    assert sites.key("alice.blog.test") is None


def test_the_host_cache_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    import naulon.sites as s

    monkeypatch.setattr(s, "MAX_HOSTS", 3)
    sites = SiteKeys(None, lambda host: "k")
    for i in range(10):
        sites.key(f"h{i}.test")
    assert len(sites._cache) == 3


# ── ASGI: the lookup never runs on the event loop ──────────────────────────────────────────────


def test_asgi_runs_the_lookup_off_the_loop_and_tolls_under_the_site_key() -> None:
    import threading

    t = recording_gate()
    n = engine(t)
    warm(n, t)
    loop_thread: list[int] = []
    lookup_thread: list[int] = []

    def key_for(host: str) -> str | None:
        lookup_thread.append(threading.get_ident())
        return KEYS.get(host)

    async def app(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/html")]})
        await send({"type": "http.response.body", "body": b"<p>a</p>"})

    mw = NaulonASGI(app, naulon=n, key_for=key_for)
    sent: list[dict[str, Any]] = []

    async def go() -> None:
        loop_thread.append(threading.get_ident())
        scope = {
            "type": "http", "method": "GET", "scheme": "http", "path": "/hello/", "raw_path": b"/hello/",
            "query_string": b"", "server": ("bob.blog.test", 80), "client": ("203.0.114.9", 1),
            "headers": [(b"host", b"bob.blog.test"), (b"user-agent", AGENT_UA.encode()), (b"accept", b"*/*")],
        }  # fmt: skip

        async def receive() -> dict[str, Any]:
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(m: dict[str, Any]) -> None:
            sent.append(dict(m))

        await mw(scope, receive, send)

    asyncio.run(go())
    assert sent[0]["status"] == 402
    assert lookup_thread and lookup_thread[0] != loop_thread[0]
    assert [auth for path, auth in t.auth if path == "/_naulon/quote"] == ["Bearer nln_bob"]
