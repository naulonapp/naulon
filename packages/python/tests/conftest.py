from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[2] / "shared" / "test-fixtures"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


from collections.abc import Callable, Mapping  # noqa: E402

from naulon.transport import Response  # noqa: E402

Route = Response | None | Callable[[str, str, bytes | None], Response | None]

AGENT_UA = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"
WALLET = "0x" + "a" * 40
LEGS = [{"role": "author", "requirements": {"payTo": WALLET, "amount": "5000", "network": "eip155:5042002"}}]
QUOTE = {"slug": "hello", "kind": "read", "title": "Hello", "price": 0.005, "payees": [], "extraLegs": []}


def config_doc(**rules: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "block": [], "allow": [], "charge": [], "refuse": {"crawlers": [], "agents": False},
        "agentReadsFree": False, "forged": "charge", "identityMode": "auto", "tollMode": "charge",
    }  # fmt: skip
    base.update(rules)
    return {
        "enforcement": {
            "articlePrefixes": [],
            "licenseIdentity": "naulon:test",
            "gateScope": {"mode": "site", "excludePrefixes": ["static"]},
        },
        "rules": base,
    }


def json_response(status: int, body: Any) -> Response:
    return Response(status, {"content-type": "application/json"}, json.dumps(body).encode())


class FakeTransport:
    """Routes by path (the part before `?`). A route may be a Response, None (no answer), or a
    function of (method, url, body). Every call is recorded."""

    def __init__(self, routes: Mapping[str, Route] | None = None) -> None:
        self.routes: dict[str, Route] = dict(routes or {})
        self.calls: list[tuple[str, str, bytes | None]] = []

    def request(
        self, method: str, url: str, *, headers: Mapping[str, str], body: bytes | None, timeout: float
    ) -> Response | None:
        self.calls.append((method, url, body))
        path = "/" + url.split("://", 1)[1].split("/", 1)[1].split("?", 1)[0]
        route = self.routes.get(path)
        if callable(route):
            return route(method, url, body)
        return route

    def paths(self) -> list[str]:
        return ["/" + u.split("://", 1)[1].split("/", 1)[1].split("?", 1)[0] for _, u, _ in self.calls]


def gate(over: Mapping[str, Route] | None = None) -> FakeTransport:
    """A healthy gate for a charging site: config, a priced quote, settles paid."""
    routes: dict[str, Route] = {
        "/_naulon/enforce-config": json_response(200, config_doc()),
        "/.well-known/naulon/crawler-ranges.json": None,
        "/_naulon/quote": json_response(200, {**QUOTE, "x402": {"header": "PAYREQ", "legs": LEGS}}),
        "/_naulon/verify": json_response(
            200, {"ok": True, "verdict": "paid", "responseHeader": "RECEIPT", "licenseJws": "a.b.c"}
        ),
        "/_naulon/license/check": json_response(200, {"entitled": False, "verdict": "refused"}),
        "/_naulon/observe": Response(202),
    }
    routes.update(over or {})
    return FakeTransport(routes)
