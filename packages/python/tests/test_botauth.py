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
