"""WSGI middleware: `app = NaulonWSGI(app)`.

A person's request goes to the app untouched. On an agent's request the status line and headers are
held until the first body chunk; a response with more than one chunk is streaming and goes out
untouched, never tolled. The app iterator's `close()` is always called.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from typing import Any

from naulon._log import warn_once
from naulon.core import Continue, Keep, Naulon, Respond
from naulon.facts import RequestFacts
from naulon.settings import Settings

StartResponse = Callable[..., Any]
WSGIApp = Callable[[dict[str, Any], StartResponse], Iterable[bytes]]
Tollable = Callable[[dict[str, Any], int, list[tuple[str, str]]], bool]

_REASONS = {200: "OK", 402: "Payment Required", 403: "Forbidden", 503: "Service Unavailable"}


def default_tollable(environ: dict[str, Any], status: int, headers: list[tuple[str, str]]) -> bool:
    ctype = next((v for k, v in headers if k.lower() == "content-type"), "")
    return status == 200 and ctype.startswith("text/html")


def facts_of(environ: dict[str, Any]) -> RequestFacts:
    headers: dict[str, str] = {}
    for k, v in environ.items():
        if k.startswith("HTTP_") and isinstance(v, str):
            headers[k[5:].replace("_", "-").lower()] = v
    for k in ("CONTENT_TYPE", "CONTENT_LENGTH"):
        if isinstance(environ.get(k), str) and environ[k]:
            headers[k.replace("_", "-").lower()] = environ[k]
    host = headers.get("host") or f"{environ.get('SERVER_NAME', '')}:{environ.get('SERVER_PORT', '')}"
    raw_path = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if isinstance(raw_path, str) and raw_path.startswith("/"):
        path, _, query = raw_path.partition("?")
    else:
        # PATH_INFO is decoded by the server and carried as latin-1 by WSGI convention.
        path = str(environ.get("SCRIPT_NAME", "")) + str(environ.get("PATH_INFO", ""))
        path = path.encode("latin-1", "replace").decode("utf-8", "replace")
        query = str(environ.get("QUERY_STRING", ""))
    return RequestFacts(
        method=str(environ.get("REQUEST_METHOD", "GET")),
        scheme=str(environ.get("wsgi.url_scheme", "http")),
        host=host,
        path=path,
        query=query,
        headers=headers,
        client_ip=environ.get("REMOTE_ADDR") if isinstance(environ.get("REMOTE_ADDR"), str) else None,
    )


def _status_line(code: int) -> str:
    return f"{code} {_REASONS.get(code, '')}".strip()


def _close(it: Any) -> None:
    close = getattr(it, "close", None)
    if callable(close):
        close()


class _Closing:
    """An iterator that yields `chunks` and closes the app's iterator when done."""

    def __init__(self, chunks: Iterator[bytes], app_iter: Any) -> None:
        self._chunks = chunks
        self._app_iter = app_iter

    def __iter__(self) -> Iterator[bytes]:
        return self._chunks

    def close(self) -> None:
        _close(self._app_iter)


class NaulonWSGI:
    def __init__(
        self,
        app: WSGIApp,
        settings: Settings | None = None,
        tollable: Tollable | None = None,
        naulon: Naulon | None = None,
    ) -> None:
        self.app = app
        s = settings or Settings.from_env()
        self.naulon = naulon or (Naulon(s) if s.active else None)
        self.tollable = tollable or default_tollable

    def __call__(self, environ: dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
        if self.naulon is None:
            return self.app(environ, start_response)
        naulon = self.naulon
        try:
            facts = facts_of(environ)
            decision = naulon.handle(facts)
        except Exception as err:
            warn_once("wsgi.start", "naulon: request passed through after an internal error (%s)", type(err).__name__)
            return self.app(environ, start_response)
        if isinstance(decision, Respond):
            start_response(_status_line(decision.status), decision.headers)
            return [decision.body]
        if not isinstance(decision, Continue) or decision.pending is None:
            return self.app(environ, start_response)
        return self._agent(environ, start_response, facts, decision)

    def _agent(
        self, environ: dict[str, Any], start_response: StartResponse, facts: RequestFacts, decision: Continue
    ) -> Iterable[bytes]:
        held: dict[str, Any] = {}

        def hold(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Callable[[bytes], Any]:
            held["status"], held["headers"], held["exc_info"] = status, list(headers), exc_info

            # An app that writes through `write()` streams: commit what it said and pass it on.
            def write(data: bytes) -> Any:
                if not held.get("sent"):
                    held["sent"] = True
                    held["write"] = start_response(status, headers, exc_info)
                return held["write"](data)

            return write

        app_iter = self.app(environ, hold)
        it = iter(app_iter)
        first = next(it, None)
        if held.get("sent") or "status" not in held:
            # Already committed through write(), or nothing to hold: pass through untouched.
            if "status" in held and not held.get("sent"):
                start_response(held["status"], held["headers"], held["exc_info"])
            return _Closing(_chain(first, it), app_iter)
        second = next(it, None) if first is not None else None
        status_text: str = held["status"]
        headers: list[tuple[str, str]] = held["headers"]
        if second is not None:
            start_response(status_text, headers, held["exc_info"])
            return _Closing(_chain(first, _chain(second, it)), app_iter)

        try:
            code = int(status_text.split(" ", 1)[0])
        except ValueError:
            code = 0
        try:
            tollable = code == 200 and bool(self.tollable(environ, code, headers))
        except Exception as err:
            warn_once("wsgi.tollable_raised", "naulon: the tollable hook raised (%s); not tolled", type(err).__name__)
            tollable = False
        assert self.naulon is not None
        outcome = self.naulon.finish(facts, decision, code, tollable)
        if isinstance(outcome, Keep):
            names = {n.lower() for n, _ in outcome.add_headers}
            kept = [(n, v) for n, v in headers if n.lower() not in names] + outcome.add_headers
            start_response(status_text, kept, held["exc_info"])
            return _Closing(_chain(first, iter(())), app_iter)
        _close(app_iter)
        r = outcome.response
        start_response(_status_line(r.status), r.headers)
        return [r.body]


def _chain(first: bytes | None, rest: Iterator[bytes]) -> Iterator[bytes]:
    if first is not None:
        yield first
    yield from rest
