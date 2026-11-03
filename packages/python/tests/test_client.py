from __future__ import annotations

import json

from conftest import LEGS, QUOTE, FakeTransport, gate, json_response

from naulon.client import FREE, Built, GateClient
from naulon.settings import Settings
from naulon.transport import Breaker, Response

S = Settings(gate="http://gate", key="k")


def client(t: FakeTransport) -> GateClient:
    return GateClient(S, t, Breaker())


def test_quote_asks_for_the_built_402_and_returns_it_verbatim() -> None:
    t = gate()
    built = client(t).quote("http://blog.test/hello/", "/hello/", "read")
    assert isinstance(built, Built) and built.header == "PAYREQ" and built.legs == LEGS
    assert "x402" not in built.quote
    url = t.calls[0][1]
    assert "build=402" in url and "observe=1" in url and "kind=read" in url


def test_a_204_is_free_and_cached() -> None:
    t = gate({"/_naulon/quote": Response(204)})
    c = client(t)
    assert c.quote("http://blog.test/x/", "/x/", "read") is FREE
    assert c.quote("http://blog.test/x/", "/x/", "read") is FREE
    assert len(t.calls) == 1


def test_a_quote_with_a_nonce_is_never_cached() -> None:
    legs = [{"requirements": {"payTo": "0x1", "amount": "1", "extra": {"nonce": "n1"}}}]
    t = gate({"/_naulon/quote": json_response(200, {**QUOTE, "x402": {"header": "H", "legs": legs}})})
    c = client(t)
    c.quote("http://blog.test/x/", "/x/", "read")
    c.quote("http://blog.test/x/", "/x/", "read")
    assert len(t.calls) == 2


def test_a_quote_the_gate_cannot_give_is_none() -> None:
    for route in (None, json_response(500, {}), json_response(200, {"no": "x402"}), Response(200, {}, b"<html>")):
        assert client(gate({"/_naulon/quote": route})).quote("http://b.test/x/", "/x/", "read") is None


def test_ask_micro_is_exact_integer_micro_usdc() -> None:
    assert Built("H", LEGS, {}).ask_micro == 5000
    assert Built("H", [], {"price": 0.1, "extraLegs": [{"amount": "300"}]}).ask_micro == 100_300
    assert Built("H", [], {"price": 0.000001}).ask_micro == 1


def test_verify_with_a_gate_timeout_is_no_verdict_not_pending() -> None:
    t = gate({"/_naulon/verify": None})
    built = Built("H", LEGS, QUOTE)
    assert client(t).settle("pay", built, "http://b.test/x/", {}).verdict is None


def test_verify_returns_pending_only_when_the_gate_says_so() -> None:
    t = gate({"/_naulon/verify": json_response(409, {"ok": False, "verdict": "pending"})})
    assert client(t).settle("pay", Built("H", LEGS, QUOTE), "http://b.test/x/", {}).verdict == "pending"
    t = gate({"/_naulon/verify": json_response(503, {"error": "x"})})
    assert client(t).settle("pay", Built("H", LEGS, QUOTE), "http://b.test/x/", {}).verdict is None


def test_verify_relays_the_legs_and_quote_exactly_as_received() -> None:
    t = gate()
    client(t).settle("pay", Built("H", LEGS, QUOTE), "http://b.test/hello/", {"ua": "GPTBot"})
    sent = json.loads(t.calls[0][2] or b"{}")
    assert sent == {
        "payment": "pay",
        "legs": LEGS,
        "quote": QUOTE,
        "resource": "http://b.test/hello/",
        "agent": {"ua": "GPTBot"},
    }


def test_the_key_travels_as_a_bearer_token_only_to_the_gate() -> None:
    seen: dict[str, str] = {}

    class Spy(FakeTransport):
        def request(self, method, url, *, headers, body, timeout):  # type: ignore[no-untyped-def]
            seen.update(headers)
            return super().request(method, url, headers=headers, body=body, timeout=timeout)

    c = GateClient(S, Spy({"/_naulon/quote": Response(204)}), Breaker())
    c.quote("http://b.test/x/", "/x/", "read")
    assert seen["authorization"] == "Bearer k"


def test_an_open_breaker_skips_the_network() -> None:
    t = gate({"/_naulon/quote": None})
    b = Breaker(threshold=2)
    c = GateClient(S, t, b)
    for i in range(5):
        c.quote(f"http://b.test/x{i}/", f"/x{i}/", "read")
    assert len(t.calls) == 2
