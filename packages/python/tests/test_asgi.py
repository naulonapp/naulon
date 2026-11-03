from __future__ import annotations

import asyncio
from typing import Any

from conftest import AGENT_UA, BROWSER_UA, gate
from helpers import naulon

from naulon.adapters.asgi import NaulonASGI


def scope(ua: str, kind: str = "http", **headers: str) -> dict[str, Any]:
    h = [
        (b"host", b"blog.test"),
        (b"user-agent", ua.encode()),
        (b"accept", b"text/html" if ua == BROWSER_UA else b"*/*"),
    ]
    h += [(k.replace("_", "-").lower().encode(), v.encode()) for k, v in headers.items()]
    return {
        "type": kind,
        "method": "GET",
        "scheme": "http",
        "path": "/hello/",
        "raw_path": b"/hello/",
        "query_string": b"",
        "headers": h,
        "client": ("203.0.114.9", 1234),
        "server": ("blog.test", 80),
    }


def app_for(chunks: list[bytes], status: int = 200) -> Any:
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await send({"type": "seen", "scope": scope["type"]})
            return
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"text/html")]})
        for i, c in enumerate(chunks):
            await send({"type": "http.response.body", "body": c, "more_body": i < len(chunks) - 1})

    return app


def run(app: Any, sc: dict[str, Any]) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    async def send(m: dict[str, Any]) -> None:
        sent.append(m)

    asyncio.run(app(sc, receive, send))
    return sent


def test_a_websocket_scope_passes_through() -> None:
    sent = run(NaulonASGI(app_for([b"x"]), naulon=naulon(gate())), scope(AGENT_UA, "websocket"))
    assert sent == [{"type": "seen", "scope": "websocket"}]


def test_a_person_is_untouched() -> None:
    t = gate()
    sent = run(NaulonASGI(app_for([b"<p>a</p>"]), naulon=naulon(t)), scope(BROWSER_UA))
    assert sent[0]["status"] == 200 and sent[1]["body"] == b"<p>a</p>" and t.calls == []


def test_an_agent_on_an_article_gets_the_402() -> None:
    sent = run(NaulonASGI(app_for([b"<p>a</p>"]), naulon=naulon(gate())), scope(AGENT_UA))
    assert sent[0]["status"] == 402 and (b"payment-required", b"PAYREQ") in sent[0]["headers"]


def test_a_paid_agent_keeps_the_body_and_gains_the_receipt() -> None:
    sent = run(NaulonASGI(app_for([b"<p>a</p>"]), naulon=naulon(gate())), scope(AGENT_UA, PAYMENT_SIGNATURE="s"))
    assert sent[0]["status"] == 200 and (b"payment-response", b"RECEIPT") in sent[0]["headers"]
    assert sent[1]["body"] == b"<p>a</p>"


def test_a_streaming_response_is_kept() -> None:
    sent = run(NaulonASGI(app_for([b"a", b"b"]), naulon=naulon(gate())), scope(AGENT_UA))
    assert sent[0]["status"] == 200 and [m["body"] for m in sent[1:]] == [b"a", b"b"]


def test_a_404_is_kept() -> None:
    sent = run(NaulonASGI(app_for([b"nope"], 404), naulon=naulon(gate())), scope(AGENT_UA))
    assert sent[0]["status"] == 404 and sent[1]["body"] == b"nope"
