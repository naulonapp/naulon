"""A signed agent end to end: the vector the gate signed, verified here, carried to the quote and the report."""

from __future__ import annotations

from typing import Any

from conftest import config_doc, fixture, gate, json_response

from naulon.core import Naulon, Replace
from naulon.facts import RequestFacts
from naulon.settings import Settings
from naulon.transport import Response

DOC = fixture("botauth-vectors.json")


def case(name: str) -> dict[str, Any]:
    return next(c for c in DOC["cases"] if c["name"] == name)


def setup(c: dict[str, Any]) -> tuple[Naulon, Any, RequestFacts]:
    d = c["directory"]
    t = gate(
        {"/.well-known/http-message-signatures-directory": Response(d["status"], d["headers"], d["body"].encode())}
    )
    t.routes["/_naulon/enforce-config"] = json_response(200, config_doc())
    n = Naulon(Settings(gate="http://gate", key="k"), transport=t, wall=lambda: c["now"] / 1000)
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config.refresh_now("gate.example")
    n.config._refresh_ranges()
    t.calls.clear()
    r = c["request"]
    # The signature covers @authority (and @path), not the user agent: a crawler's UA rides along.
    headers = {**r["headers"], "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)"}
    f = RequestFacts(
        method="GET", scheme="http", host="gate.example", path=r["path"], headers=headers, client_ip="198.51.100.7"
    )
    return n, t, f


def test_a_verified_signer_is_quoted_as_itself_and_reported_verified() -> None:
    n, t, f = setup(case("a signed request verifies"))
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Replace) and out.response.status == 402
    quote_url = next(u for _, u, _ in t.calls if "/_naulon/quote" in u)
    assert "verifiedAgent=signer.example" in quote_url
    agent = list(n.observations._items)[0]["agent"]
    assert agent["verified"] is True and agent["verifiedAgent"] == "signer.example"
    assert agent["classifyReason"] == "verified web-bot-auth (signer.example)", "the signature outranks the user agent"


def test_a_tampered_signature_is_reported_and_still_priced_by_its_user_agent() -> None:
    n, t, f = setup(case("a tampered signature fails"))
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Replace)
    agent = list(n.observations._items)[0]["agent"]
    assert agent.get("sigInvalid") is True and "verified" not in agent


def test_an_unsigned_request_never_fetches_a_directory() -> None:
    n, t, f = setup(case("no signature headers is absent"))
    n.finish(f, n.handle(f), 200, True)
    assert not any("http-message-signatures-directory" in u for _, u, _ in t.calls)
    agent = list(n.observations._items)[0]["agent"]
    assert "verified" not in agent and "sigInvalid" not in agent, "no verdict on a signature that was never presented"
