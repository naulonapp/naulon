"""ASGI middleware: `app = NaulonASGI(app)`. HTTP only; `websocket` and `lifespan` pass straight through.
A platform hosting many sites passes `credential_for=lambda host: ...` (see `naulon.sites`); it may
block on a database, so a cache miss runs it on a worker thread, never on the event loop. Given
`connect=`, it also answers the two connect paths the gate fetches, on that same thread pool, because
a platform's connect store is its database too.

On an agent's request `http.response.start` is held until the first body message. A body sent with
`more_body: true` is streaming and goes out untouched, never tolled.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import dataclasses
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from naulon._log import warn_error
from naulon.connect import Connect
from naulon.core import Continue, Keep, Naulon, Respond
from naulon.facts import RequestFacts
from naulon.settings import Settings
from naulon.sites import DEFAULT_TTL_S, CredentialFor, SiteCredentials, _Miss

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]
Tollable = Callable[[Scope, int, list[tuple[str, str]]], bool]

# `finish` may wait on the gate or a signer's key directory. It runs here rather than on the default
# executor, so a slow agent path can never take the threads the app itself runs blocking work on.
_FINISH_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="naulon-finish")


def default_tollable(scope: Scope, status: int, headers: list[tuple[str, str]]) -> bool:
    ctype = next((v for k, v in headers if k.lower() == "content-type"), "")
    return status == 200 and ctype.startswith("text/html")


def _text(b: Any) -> str:
    return b.decode("latin-1") if isinstance(b, (bytes, bytearray)) else str(b)


def facts_of(scope: Scope) -> RequestFacts:
    headers: dict[str, str] = {}
    for k, v in scope.get("headers", []):
        name = _text(k).lower()
        headers[name] = f"{headers[name]}, {_text(v)}" if name in headers else _text(v)
    raw = scope.get("raw_path")
    path = _text(raw).split("?", 1)[0] if raw else str(scope.get("path", "/"))
    server = scope.get("server") or ("", None)
    host = headers.get("host") or (f"{server[0]}:{server[1]}" if server[1] else str(server[0]))
    client = scope.get("client")
    return RequestFacts(
        method=str(scope.get("method", "GET")),
        scheme=str(scope.get("scheme", "http")),
        host=host,
        path=path,
        query=_text(scope.get("query_string", b"")),
        headers=headers,
        client_ip=str(client[0]) if client else None,
    )


def _wire(headers: list[tuple[str, str]]) -> list[tuple[bytes, bytes]]:
    return [(n.lower().encode("latin-1"), v.encode("latin-1")) for n, v in headers]


async def _send_respond(send: Send, r: Respond) -> None:
    await send({"type": "http.response.start", "status": r.status, "headers": _wire(r.headers)})
    await send({"type": "http.response.body", "body": r.body})


class NaulonASGI:
    def __init__(
        self,
        app: ASGIApp,
        settings: Settings | None = None,
        tollable: Tollable | None = None,
        naulon: Naulon | None = None,
        credential_for: CredentialFor | None = None,
        credential_ttl_s: float = DEFAULT_TTL_S,
        connect: Connect | None = None,
    ) -> None:
        self.app = app
        s = settings or Settings.from_env()
        self.sites = SiteCredentials(s.key, credential_for, credential_ttl_s)
        self.naulon = naulon or (Naulon(s) if s.active and self.sites.any else None)
        self.tollable = tollable or default_tollable
        self.connect = connect

    async def _well_known(self, scope: Scope) -> Respond | None:
        if self.connect is None:
            return None
        if not self.connect.handles(str(scope.get("path", ""))):
            return None  # every other request skips the thread hop
        try:
            f = facts_of(scope)
            query = bytes(scope.get("query_string", b"")).decode("latin-1")
            loop = asyncio.get_running_loop()
            answer = await loop.run_in_executor(
                _FINISH_POOL, self.connect.answer, f.scheme, f.host, f.path, f.method, query
            )
        except Exception as err:
            warn_error("asgi.connect", "naulon: a connect path could not be answered", err)
            return None
        return None if answer is None else Respond(answer.status, list(answer.headers), answer.body)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        # Before the toll, and whether or not anything is tolled yet: a site connecting for the first
        # time has no credential, and that is exactly when the gate asks.
        answered = await self._well_known(scope)
        if answered is not None:
            await _send_respond(send, answered)
            return
        if self.naulon is None:
            await self.app(scope, receive, send)
            return
        naulon = self.naulon
        try:
            facts = facts_of(scope)
            site = self.sites.peek(facts.host)
            if isinstance(site, _Miss):
                loop = asyncio.get_running_loop()
                site = await loop.run_in_executor(_FINISH_POOL, self.sites.lookup, facts.host)
            if self.sites.per_site and site is None:
                await self.app(scope, receive, send)  # this site has not turned naulon on
                return
            facts = dataclasses.replace(facts, site=site)
            decision = naulon.handle(facts)
        except Exception as err:
            warn_error("asgi.start", "naulon: request passed through after an internal error", err)
            await self.app(scope, receive, send)
            return
        if isinstance(decision, Respond):
            await _send_respond(send, decision)
            return
        if not isinstance(decision, Continue) or decision.pending is None:
            await self.app(scope, receive, send)
            return

        state: dict[str, Any] = {"start": None, "passing": False}

        async def held_send(message: Message) -> None:
            if state["passing"]:
                await send(message)
                return
            if message["type"] == "http.response.start":
                state["start"] = message
                return
            if message["type"] != "http.response.body" or state["start"] is None:
                state["passing"] = True
                if state["start"] is not None:
                    await send(state["start"])
                await send(message)
                return
            start: Message = state["start"]
            state["passing"] = True
            if message.get("more_body"):
                # Streaming: never read, never tolled.
                await send(start)
                await send(message)
                return
            await self._finish(scope, facts, decision, start, message, send)

        await self.app(scope, receive, held_send)
        if not state["passing"] and state["start"] is not None:
            await send(state["start"])
            await send({"type": "http.response.body", "body": b""})

    async def _finish(
        self, scope: Scope, facts: RequestFacts, decision: Continue, start: Message, body: Message, send: Send
    ) -> None:
        assert self.naulon is not None
        status = int(start.get("status", 0))
        headers = [(_text(k), _text(v)) for k, v in start.get("headers", [])]
        try:
            tollable = status == 200 and bool(self.tollable(scope, status, headers))
        except Exception as err:
            warn_error("asgi.tollable_raised", "naulon: the tollable hook raised; not tolled", err)
            tollable = False
        try:
            # `finish` may ask the gate over the network: off the event loop.
            loop = asyncio.get_running_loop()
            outcome = await loop.run_in_executor(_FINISH_POOL, self.naulon.finish, facts, decision, status, tollable)
        except Exception as err:
            warn_error("asgi.finish", "naulon: the page was served after an internal error", err)
            outcome = Keep()
        if isinstance(outcome, Keep):
            if outcome.add_headers:
                names = {n.lower() for n, _ in outcome.add_headers}
                kept = [(k, v) for k, v in start.get("headers", []) if _text(k).lower() not in names]
                start = {**start, "headers": kept + _wire(outcome.add_headers)}
            await send(start)
            await send(body)
            return
        await _send_respond(send, outcome.response)
