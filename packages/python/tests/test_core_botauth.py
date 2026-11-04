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
    n = Naulon(
        Settings(gate="http://gate", key="k"),
        transport=t,
        wall=lambda: c["now"] / 1000,
        directory_fetch=lambda url: t.request("GET", url, headers={}, body=None, timeout=3),
    )
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config.refresh_now("gate.example", "k")
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
    agent = n.observations.queued()[0]["agent"]
    assert agent["verified"] is True and agent["verifiedAgent"] == "signer.example"
    assert agent["classifyReason"] == "verified web-bot-auth (signer.example)", "the signature outranks the user agent"


def test_a_tampered_signature_is_reported_and_still_priced_by_its_user_agent() -> None:
    n, t, f = setup(case("a tampered signature fails"))
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Replace)
    agent = n.observations.queued()[0]["agent"]
    assert agent.get("sigInvalid") is True and "verified" not in agent


def test_an_unsigned_request_never_fetches_a_directory() -> None:
    n, t, f = setup(case("no signature headers is absent"))
    n.finish(f, n.handle(f), 200, True)
    assert not any("http-message-signatures-directory" in u for _, u, _ in t.calls)
    agent = n.observations.queued()[0]["agent"]
    assert "verified" not in agent and "sigInvalid" not in agent, "no verdict on a signature that was never presented"


def test_the_first_signed_request_never_fetches_before_the_view() -> None:
    from naulon.core import Continue
    from naulon.decide import Recheck

    n, t, f = setup(case("a signed request verifies"))
    d = n.handle(f)
    assert isinstance(d, Continue) and isinstance(d.pending, Recheck)
    assert t.calls == [], "no directory fetch on the request thread or the event loop"
    n.finish(f, d, 200, True)
    assert any("http-message-signatures-directory" in u for _, u, _ in t.calls)
    t.calls.clear()
    d2 = n.handle(f)
    assert not isinstance(d2.pending, Recheck), "a cached directory decides before the view"  # type: ignore[union-attr]
    assert t.calls == []


def test_a_deferred_check_on_a_404_keeps_the_page_when_nothing_refuses() -> None:
    from naulon.core import Keep

    n, t, f = setup(case("a signed request verifies"))
    assert n.finish(f, n.handle(f), 404, False) == Keep()
    assert not any("/_naulon/quote" in u for _, u, _ in t.calls), "a 404 is never priced"


def test_a_blocked_crawler_is_refused_before_the_view_even_while_its_signature_waits() -> None:
    from naulon.core import Respond

    n, t, f = setup(case("a signed request verifies"))
    t.routes["/_naulon/enforce-config"] = json_response(200, config_doc(block=["gptbot"]))
    n.config.refresh_now("gate.example", "k")
    t.calls.clear()
    d = n.handle(f)
    assert isinstance(d, Respond) and d.status == 403
    assert not any("http-message-signatures-directory" in u for _, u, _ in t.calls)


def test_a_refusal_the_deferred_check_reaches_applies_to_a_non_article_too() -> None:
    from naulon.core import Continue, Replace
    from naulon.decide import Recheck

    # A verified signer refused by the site's terms, behind a browser user agent: unsigned it reads as
    # a person, so the refusal exists only once the signature is checked.
    n, t, f = setup(case("a signed request verifies"))
    f = RequestFacts(
        f.method,
        f.scheme,
        f.host,
        f.path,
        f.query,
        {**f.headers, "user-agent": "Mozilla/5.0", "accept": "text/html"},
        f.client_ip,
    )
    t.routes["/_naulon/enforce-config"] = json_response(200, config_doc(refuse={"crawlers": [], "agents": True}))
    n.config.refresh_now("gate.example", "k")
    d = n.handle(f)
    assert isinstance(d, Continue) and isinstance(d.pending, Recheck)
    out = n.finish(f, d, 404, False)
    assert isinstance(out, Replace) and out.response.status == 403
