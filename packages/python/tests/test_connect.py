"""Connect, and a site on its own gate. The wire rules are checked against connect-cases.json, the
file the TypeScript runner reads."""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

import pytest
from conftest import AGENT_UA, FakeTransport, fixture, json_response

from naulon.adapters.wsgi import NaulonWSGI
from naulon.connect import (
    CHALLENGE_PATH,
    CLIENT_METADATA_PATH,
    Connect,
    Connected,
    Discovery,
    Failed,
    Started,
    code_challenge,
    is_connect_path,
    parse_discovery,
    site_origin,
)
from naulon.settings import Settings
from naulon.sites import Gates, Site, SiteCredentials
from naulon.transport import GuardedTransport, Response

CASES = fixture("connect-cases.json")
GATE = "https://gate.test"
SITE = "https://blog.test"


@pytest.mark.parametrize("case", CASES["pkce"])
def test_pkce_matches_the_typescript_runner(case: dict[str, str]) -> None:
    assert code_challenge(case["verifier"]) == case["challenge"]


@pytest.mark.parametrize("case", CASES["siteOrigins"])
def test_a_site_origin_matches_the_typescript_runner(case: dict[str, Any]) -> None:
    assert site_origin(case["input"]) == case["origin"]


@pytest.mark.parametrize("case", CASES["discovery"])
def test_discovery_matches_the_typescript_runner(case: dict[str, Any]) -> None:
    r = parse_discovery(case["body"], case["gate"])
    assert isinstance(r, Discovery) == case["ok"], r
    if isinstance(r, str) and "error" in case:
        assert case["error"] in r


def discovery(issuer: str = GATE, authorize: str = "https://console.test/connect/authorize") -> dict[str, Any]:
    return {
        "issuer": issuer,
        "protocol": "naulon/1",
        "enforce_api": f"{issuer}/_naulon",
        "authorization_endpoint": authorize,
        "token_endpoint": f"{issuer}/_naulon/connect/token",
        "revocation_endpoint": f"{issuer}/_naulon/connect/revoke",
        "jwks_uri": f"{issuer}/.well-known/naulon-jwks.json",
        "challenge_path": CHALLENGE_PATH,
        "code_challenge_methods_supported": ["S256"],
        "client_id_metadata_document_supported": True,
        "network": {"member": False},
    }


CREDENTIAL = "nln_site_" + "A" * 43


def token_route(site: str = SITE, credential: str = CREDENTIAL, status: int = 200) -> Any:
    def route(method: str, url: str, body: bytes | None) -> Response:
        form = urllib.parse.parse_qs((body or b"").decode())
        assert method == "POST" and form["grant_type"] == ["authorization_code"] and form["code"] == ["nln_code_x"]
        token_route.verifier = form["code_verifier"][0]  # type: ignore[attr-defined]
        return json_response(
            status, {"access_token": credential, "token_type": "Bearer", "scope": "site.enforce", "site": site}
        )

    return route


def connect(t: FakeTransport, **kw: Any) -> Connect:
    return Connect("My blog", gate=GATE, transport=t, **kw)


def start(c: Connect) -> dict[str, str]:
    started = c.start(SITE)
    assert isinstance(started, Started), started
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(started.url).query))


def test_a_connect_runs_start_to_credential_and_the_site_answers_its_own_challenge() -> None:
    t = FakeTransport({"/.well-known/naulon": json_response(200, discovery()), "/_naulon/connect/token": token_route()})
    c = connect(t)
    q = start(c)
    assert q["site"] == SITE and q["client_id"] == f"{SITE}{CLIENT_METADATA_PATH}"
    assert q["redirect_uri"] == f"{SITE}/naulon/connect/return" and q["code_challenge_method"] == "S256"

    challenge = c.well_known("https", "blog.test", f"{CHALLENGE_PATH}{q['state']}")
    assert challenge is not None and challenge.status == 200 and challenge.body.decode().strip() == q["code_challenge"]
    assert c.well_known("https", "other.test", f"{CHALLENGE_PATH}{q['state']}").status == 404, "only on its own host"  # type: ignore[union-attr]
    assert c.well_known("https", "blog.test", f"{CHALLENGE_PATH}{'x' * 32}").status == 404  # type: ignore[union-attr]
    meta = c.well_known("https", "blog.test", CLIENT_METADATA_PATH)
    assert meta is not None
    assert json.loads(meta.body) == {
        "client_id": f"{SITE}{CLIENT_METADATA_PATH}",
        "client_name": "My blog",
        "redirect_uris": [f"{SITE}/naulon/connect/return"],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code"],
    }

    done = c.finish({"state": q["state"], "code": "nln_code_x"})
    assert done == Connected(SITE, GATE, CREDENTIAL)
    assert code_challenge(token_route.verifier) == q["code_challenge"]  # type: ignore[attr-defined]
    assert "nln_site_" not in repr(done), "a credential never reaches a log through repr"
    again = c.finish({"state": q["state"], "code": "nln_code_x"})
    assert isinstance(again, Failed) and again.error == "expired"


def test_each_way_a_connect_can_end_without_a_credential() -> None:
    def gate_with(token: Any) -> Connect:
        return connect(
            FakeTransport({"/.well-known/naulon": json_response(200, discovery()), "/_naulon/connect/token": token})
        )

    c = gate_with(token_route())
    assert c.finish({"state": start(c)["state"], "error": "access_denied"}) == Failed(
        "denied", "the gate's owner did not approve this site"
    )
    assert c.finish({"state": "short"}).error == "invalid"  # type: ignore[union-attr]
    c = gate_with(json_response(400, {"error": "invalid_grant", "error_description": "code expired"}))
    assert c.finish({"state": start(c)["state"], "code": "nln_code_x"}) == Failed("refused", "code expired")
    c = gate_with(token_route(site="https://someone-else.test"))
    assert (
        c.finish({"state": start(c)["state"], "code": "nln_code_x"}).message
        == "the gate returned a credential for something else"
    )  # type: ignore[union-attr]
    c = gate_with(token_route(credential="nln_live_abc"))
    assert (
        c.finish({"state": start(c)["state"], "code": "nln_code_x"}).message == "the gate returned no site credential"
    )  # type: ignore[union-attr]


def test_start_refuses_a_bad_site_gate_or_return_address_before_any_network() -> None:
    t = FakeTransport({"/.well-known/naulon": json_response(200, discovery())})
    c = connect(t)
    assert c.start("https://blog.test/posts").error == "invalid"  # type: ignore[union-attr]
    assert c.start(SITE, gate="http://gate.example.com") == Failed("invalid", "the gate must be an https URL")
    assert c.start(SITE, return_to="https://evil.test/cb").error == "invalid"  # type: ignore[union-attr]
    assert t.calls == []
    not_a_gate = connect(
        FakeTransport({"/.well-known/naulon": json_response(200, discovery(issuer="https://other.test"))})
    )
    assert not_a_gate.start(SITE) == Failed("refused", "issuer https://other.test does not match https://gate.test")


def test_a_platform_with_one_client_document_declares_its_own_return_page() -> None:
    c = connect(
        FakeTransport({"/.well-known/naulon": json_response(200, discovery())}),
        client_id=lambda site: "https://platform.test/.well-known/naulon-client",
        redirect_uris=lambda site: ["https://platform.test/settings/naulon/return"],
    )
    q = start(c)
    assert q["client_id"] == "https://platform.test/.well-known/naulon-client"
    assert c.well_known("https", "blog.test", CLIENT_METADATA_PATH) is None, "the document lives on the platform"
    doc = c.well_known("https", "platform.test", CLIENT_METADATA_PATH)
    assert doc is not None and json.loads(doc.body)["redirect_uris"] == ["https://platform.test/settings/naulon/return"]


def test_is_connect_path() -> None:
    assert is_connect_path(CLIENT_METADATA_PATH) and is_connect_path(f"{CHALLENGE_PATH}abc")
    assert not is_connect_path("/") and not is_connect_path("/.well-known/naulon-jwks.json")


# ── a site on its own gate ─────────────────────────────────────────────────────────────────────


def test_a_site_on_its_own_gate_is_routed_there_with_its_own_breaker_and_the_guarded_transport() -> None:
    plain, guarded = FakeTransport(), FakeTransport()
    gates = Gates(GATE, plain, guarded)
    home, own = gates.route(Site("k")), gates.route(Site("k", "https://own.test"))
    assert home is not None and own is not None
    assert (home.base, home.transport) == (GATE, plain)
    assert (own.base, own.transport) == ("https://own.test", guarded)
    for _ in range(10):
        own.breaker.record(False)
    assert not own.breaker.allow() and home.breaker.allow(), "one writer's dead gate never stops anyone else's toll"


@pytest.mark.parametrize("gate", ["http://evil.test", "ftp://x", "not a url", "https://u:p@evil.test"])
def test_a_saved_gate_that_is_not_https_leaves_the_site_untouched(gate: str) -> None:
    sites = SiteCredentials(None, lambda host: Site("k", gate))
    assert sites.site("blog.test") is None


def test_a_site_credential_repr_never_shows_the_secret() -> None:
    assert "secret" not in repr(Site("secret", "https://own.test"))


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",
        "https://127.0.0.1/",
        "https://10.0.0.1/",
        "https://[::1]/",
        "https://169.254.169.254/",
        "https://localhost/",
        "https://u:p@example.com/",
    ],
)
def test_the_guarded_transport_refuses_before_a_byte_is_sent(url: str) -> None:
    assert GuardedTransport().request("GET", url, headers={}, body=None, timeout=1.0) is None


# ── the adapters ───────────────────────────────────────────────────────────────────────────────


def run(app: Any, environ: dict[str, Any]) -> tuple[str, list[tuple[str, str]], bytes]:
    out: dict[str, Any] = {}

    def start_response(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> None:
        out["status"], out["headers"] = status, headers

    body = b"".join(app(environ, start_response))
    return out["status"], out["headers"], body


def environ(path: str, host: str = "blog.test") -> dict[str, Any]:
    return {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": path,
        "wsgi.url_scheme": "https",
        "HTTP_HOST": host,
        "HTTP_USER_AGENT": AGENT_UA,
    }


def page(environ: dict[str, Any], start_response: Any) -> list[bytes]:
    start_response("200 OK", [("Content-Type", "text/html")])
    return [b"<p>page</p>"]


def test_wsgi_answers_the_connect_paths_before_any_credential_exists() -> None:
    c = connect(FakeTransport({"/.well-known/naulon": json_response(200, discovery())}))
    state = start(c)["state"]
    mw = NaulonWSGI(page, settings=Settings(gate=GATE, key=None), connect=c)
    assert mw.naulon is None, "nothing to toll with yet"
    status, headers, body = run(mw, environ(f"{CHALLENGE_PATH}{state}"))
    assert status == "200 OK" and body.strip() and ("Cache-Control", "no-store") in headers
    assert run(mw, environ(f"{CHALLENGE_PATH}{'x' * 32}"))[0] == "404 Not Found"
    assert run(mw, environ("/essay/"))[2] == b"<p>page</p>"


def test_with_nothing_to_toll_with_the_middleware_makes_no_calls() -> None:
    assert NaulonWSGI(page, settings=Settings.from_env({})).naulon is None


def test_the_guarded_transport_reaches_an_allowed_target_and_never_follows_a_redirect() -> None:
    import http.server
    import threading

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/moved":
                self.send_response(302)
                self.send_header("Location", "http://169.254.169.254/")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("X-Host", self.headers.get("Host", ""))
            self.end_headers()
            self.wfile.write(b"hello")

        def log_message(self, *args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://localhost:{server.server_address[1]}"
    try:
        t = GuardedTransport(allow_private=True)
        res = t.request("GET", f"{base}/", headers={}, body=None, timeout=2.0)
        assert res is not None and res.status == 200 and res.body == b"hello"
        assert res.headers["x-host"] == f"localhost:{server.server_address[1]}", (
            "the Host is the name, not the pinned address"
        )
        moved = t.request("GET", f"{base}/moved", headers={}, body=None, timeout=2.0)
        assert moved is not None and moved.status == 302, "returned, never followed"
        assert GuardedTransport().request("GET", f"{base}/", headers={}, body=None, timeout=2.0) is None
    finally:
        server.shutdown()


def test_the_guarded_transport_holds_one_deadline_for_the_whole_exchange() -> None:
    import http.server
    import threading
    import time

    class Drip(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.end_headers()
            for _ in range(50):
                self.wfile.write(b"x")
                self.wfile.flush()
                time.sleep(0.1)

        def log_message(self, *args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Drip)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        started = time.monotonic()
        res = GuardedTransport(allow_private=True).request(
            "GET", f"http://127.0.0.1:{server.server_address[1]}/", headers={}, body=None, timeout=0.35
        )
        assert res is None, "a byte at a time never resets the clock"
        assert time.monotonic() - started < 1.0
    finally:
        server.shutdown()


def test_a_loopback_gate_named_at_runtime_is_never_reached() -> None:
    c = Connect("Platform", gate="https://gate.naulon.app")
    assert c._transport_for("http://127.0.0.1:6379")._allow_private is False  # type: ignore[attr-defined]
    local = Connect("Local walk", gate="http://127.0.0.1:8402")
    assert local._transport_for("http://127.0.0.1:8402")._allow_private is True  # type: ignore[attr-defined]
    assert local._transport_for("http://127.0.0.1:9999")._allow_private is False  # type: ignore[attr-defined]


def test_slow_headers_hit_the_same_deadline_as_a_slow_body() -> None:
    import socket as s
    import threading
    import time

    srv = s.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()

    def drip_headers() -> None:
        conn, _ = srv.accept()
        conn.recv(1024)
        try:
            for ch in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"x" * 100:
                conn.send(bytes([ch]))
                time.sleep(0.05)
        except OSError:
            pass
        conn.close()

    threading.Thread(target=drip_headers, daemon=True).start()
    started = time.monotonic()
    res = GuardedTransport(allow_private=True).request(
        "GET", f"http://127.0.0.1:{srv.getsockname()[1]}/", headers={}, body=None, timeout=0.4
    )
    assert res is None and time.monotonic() - started < 1.0
    srv.close()


def test_lookups_past_the_cap_are_refused_at_once_not_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    import time

    import naulon.transport as tr

    monkeypatch.setattr(tr, "_lookups", threading.BoundedSemaphore(2))
    release = threading.Event()
    for _ in range(2):
        threading.Thread(target=tr._resolve_within, args=(lambda: (release.wait(), None)[1], 5.0), daemon=True).start()
    time.sleep(0.05)
    started = time.monotonic()
    assert tr._resolve_within(lambda: ["1.1.1.1"], 5.0) is None
    assert time.monotonic() - started < 0.1, "refused, not queued behind the stalled ones"
    release.set()
