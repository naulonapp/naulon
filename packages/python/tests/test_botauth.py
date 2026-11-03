"""botauth-vectors.json: signed requests and the outcome the gate's own verifier reaches for each."""

from __future__ import annotations

import builtins
from typing import Any

import pytest
from conftest import fixture

from naulon import botauth
from naulon.transport import Response

DOC = fixture("botauth-vectors.json")


def run(c: dict[str, Any]) -> botauth.Outcome:
    r = c["request"]
    req = botauth.SignedRequest(r["authority"], r["method"], r["path"], r["targetUri"], r["headers"])
    d = c["directory"]
    fetched: list[str] = []

    def fetch(url: str) -> Response | None:
        fetched.append(url)
        return (
            None
            if d is None
            else Response(d["status"], {k.lower(): v for k, v in d["headers"].items()}, d["body"].encode())
        )

    return botauth.verify(req, fetch, botauth.DirectoryCache(), c["now"] / 1000)


@pytest.mark.parametrize("c", DOC["cases"], ids=[c["name"] for c in DOC["cases"]])
def test_vector(c: dict[str, Any]) -> None:
    out = run(c)
    assert out.status == c["expect"]["status"], out.reason
    if out.status == "verified":
        assert out.agent == c["expect"]["agent"] and out.keyid == c["expect"]["keyid"]
        assert list(out.covers) == c["expect"]["covers"]


def test_the_thumbprint_matches_the_gates() -> None:
    verified = next(c for c in DOC["cases"] if c["expect"]["status"] == "verified")
    import json

    x = json.loads(verified["directory"]["body"])["keys"][0]["x"]
    assert botauth.jwk_thumbprint(x) == verified["expect"]["keyid"]


def test_a_missing_extra_reads_unverified_without_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = builtins.__import__

    def no_crypto(name: str, *a: Any, **k: Any) -> Any:
        if name.startswith("cryptography"):
            raise ImportError(name)
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_crypto)
    verified = next(c for c in DOC["cases"] if c["expect"]["status"] == "verified")
    assert run(verified).status == "unverified"


def test_the_directory_cache_fetches_once_per_ttl() -> None:
    verified = next(c for c in DOC["cases"] if c["expect"]["status"] == "verified")
    r, d = verified["request"], verified["directory"]
    req = botauth.SignedRequest(r["authority"], r["method"], r["path"], r["targetUri"], r["headers"])
    calls: list[str] = []

    def fetch(url: str) -> Response:
        calls.append(url)
        return Response(d["status"], {k.lower(): v for k, v in d["headers"].items()}, d["body"].encode())

    cache = botauth.DirectoryCache()
    for _ in range(5):
        assert botauth.verify(req, fetch, cache, verified["now"] / 1000).status == "verified"
    assert calls == ["https://signer.example/.well-known/http-message-signatures-directory"]


@pytest.mark.parametrize(
    "agent",
    ["https://user:pw@signer.example", "https://signer.example:8443", "https://10.0.0.1", "https://[::1]",
     "https://0x7f000001", "https://2130706433", "https://metadata", "https://signer.123", "http://signer.example",
     "https://localhost", "https://a.localhost"],
)  # fmt: skip
def test_a_directory_host_the_caller_could_aim_inward_is_refused(agent: str) -> None:
    assert botauth._directory_url(agent) is None


def test_a_strict_dns_name_on_443_is_allowed() -> None:
    assert botauth._directory_url("https://crawler.exa.ai") == (
        "https://crawler.exa.ai/.well-known/http-message-signatures-directory",
        "crawler.exa.ai",
    )
    assert botauth._directory_url("https://chatgpt.com:443") is not None


def test_the_pinned_fetch_refuses_a_name_that_resolves_inward(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    for addr in ("127.0.0.1", "10.66.0.2", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"):
        family = socket.AF_INET6 if ":" in addr else socket.AF_INET
        monkeypatch.setattr(socket, "getaddrinfo", lambda *a, _f=family, _a=addr, **k: [(_f, 1, 6, "", (_a, 443))])
        connected: list[object] = []
        monkeypatch.setattr(socket, "create_connection", lambda *a, _c=connected, **k: _c.append(a) or None)
        assert botauth.pinned_fetch("https://evil.example/.well-known/http-message-signatures-directory") is None
        assert connected == [], addr


def test_rotation_refetches_at_most_once_a_minute() -> None:
    verified = next(c for c in DOC["cases"] if c["expect"]["status"] == "verified")
    other = next(c for c in DOC["cases"] if c["name"] == "a keyid the directory does not list fails")
    r, d = other["request"], verified["directory"]
    req = botauth.SignedRequest(r["authority"], r["method"], r["path"], r["targetUri"], r["headers"])
    now = [0.0]
    calls: list[str] = []

    def fetch(url: str) -> Response:
        calls.append(url)
        return Response(d["status"], {k.lower(): v for k, v in d["headers"].items()}, d["body"].encode())

    cache = botauth.DirectoryCache(clock=lambda: now[0])
    for _ in range(20):
        assert botauth.verify(req, fetch, cache, other["now"] / 1000).status == "invalid"
    assert len(calls) == 1
    now[0] = 61
    botauth.verify(req, fetch, cache, other["now"] / 1000)
    assert len(calls) == 2


def test_a_resolver_that_hangs_is_abandoned_at_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket
    import threading
    import time

    release = threading.Event()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: release.wait(5) or [])
    start = time.monotonic()
    assert (
        botauth.pinned_fetch("https://slow.example/.well-known/http-message-signatures-directory", timeout=0.3) is None
    )
    assert time.monotonic() - start < 1.0
    release.set()


def test_a_burst_for_one_directory_fetches_once() -> None:
    import threading
    import time

    verified = next(c for c in DOC["cases"] if c["expect"]["status"] == "verified")
    r, d = verified["request"], verified["directory"]
    req = botauth.SignedRequest(r["authority"], r["method"], r["path"], r["targetUri"], r["headers"])
    calls: list[str] = []

    def slow_fetch(url: str) -> Response:
        calls.append(url)
        time.sleep(0.2)
        return Response(d["status"], {k.lower(): v for k, v in d["headers"].items()}, d["body"].encode())

    cache = botauth.DirectoryCache()
    results: list[str] = []
    threads = [
        threading.Thread(
            target=lambda: results.append(botauth.verify(req, slow_fetch, cache, verified["now"] / 1000).status)
        )
        for _ in range(10)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and results == ["verified"] * 10


def test_stuck_lookups_hold_their_slots_so_they_cannot_pile_up(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket
    import threading
    import time

    release = threading.Event()
    started: list[str] = []

    def hang(host: str, *a: object, **k: object) -> list[object]:
        started.append(host)
        release.wait(5)
        return []

    monkeypatch.setattr(socket, "getaddrinfo", hang)
    for i in range(6):
        assert botauth.pinned_fetch(f"https://slow{i}.example/x", timeout=0.1) is None
    assert len(started) == 4, "a fifth fetch never queues behind four stuck lookups"
    release.set()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and botauth._FETCH_SLOTS._value < 4:  # type: ignore[attr-defined]
        time.sleep(0.01)
    assert botauth._FETCH_SLOTS._value == 4, "every slot comes back once the lookups finish"  # type: ignore[attr-defined]
