"""WSGI middleware: `app = NaulonWSGI(app)`. A platform hosting many sites passes
`credential_for=lambda host: ...`, returning what that site connected or None (see `naulon.sites`).
Given `connect=`, it also answers the two connect paths the gate fetches (see `naulon.connect`).

A person's request goes to the app untouched. On an agent's request the status line and headers are
held until the first body chunk; a response with more than one chunk is streaming and goes out
untouched, never tolled. The app iterator's `close()` is always called.
"""

from __future__ import annotations

import dataclasses
import urllib.parse
from collections.abc import Callable, Iterable, Iterator
from typing import Any

from naulon._log import warn_error
from naulon.connect import Connect
from naulon.core import Continue, Keep, Naulon, Respond
from naulon.facts import RequestFacts
from naulon.settings import Settings
from naulon.sites import DEFAULT_TTL_S, CredentialFor, SiteCredentials

StartResponse = Callable[..., Any]
WSGIApp = Callable[[dict[str, Any], StartResponse], Iterable[bytes]]
Tollable = Callable[[dict[str, Any], int, list[tuple[str, str]]], bool]

_REASONS = {200: "OK", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 503: "Service Unavailable"}


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
        # PATH_INFO is decoded by the server and carried as latin-1 by WSGI convention. Re-quoted, as
        # Django's get_full_path does, so the slug is decoded once: `100%25-off` stays `100%-off`.
        path = str(environ.get("SCRIPT_NAME", "")) + str(environ.get("PATH_INFO", ""))
        path = urllib.parse.quote(path.encode("latin-1", "replace"), safe="/:@!$&'()*+,;=-._~")
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

    def __call__(self, environ: dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
        if self.connect is not None:
            # Before the toll, and whether or not anything is tolled yet: a site connecting for the
            # first time has no credential, and that is exactly when the gate asks.
            try:
                f = facts_of(environ)
                answer = (
                    self.connect.answer(f.scheme, f.host, f.path, f.method, str(environ.get("QUERY_STRING", "")))
                    if self.connect.handles(f.path)
                    else None
                )
            except Exception as err:
                warn_error("wsgi.connect", "naulon: a connect path could not be answered", err)
                answer = None
            if answer is not None:
                start_response(_status_line(answer.status), list(answer.headers))
                return [answer.body]
        if self.naulon is None:
            return self.app(environ, start_response)
        naulon = self.naulon
        try:
            facts = facts_of(environ)
            site = self.sites.site(facts.host)
            if self.sites.per_site and site is None:
                return self.app(environ, start_response)  # this site has not turned naulon on
            facts = dataclasses.replace(facts, site=site)
            decision = naulon.handle(facts)
        except Exception as err:
            warn_error("wsgi.start", "naulon: request passed through after an internal error", err)
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
        status_text: str = held["status"]
        headers: list[tuple[str, str]] = held["headers"]
        try:
            code = int(status_text.split(" ", 1)[0])
        except ValueError:
            code = 0
        try:
            tollable = code == 200 and bool(self.tollable(environ, code, headers))
        except Exception as err:
            warn_error("wsgi.tollable_raised", "naulon: the tollable hook raised; not tolled", err)
            tollable = False
        assert self.naulon is not None

        rest: Iterator[bytes] = it
        if tollable:
            # Only an article is held for a second chunk, to tell a single-body response from a
            # stream. Anything else is decided from its headers and passed on at once, so an event
            # stream or a long poll is never held waiting for a chunk that may not come.
            second = next(it, None) if first is not None else None
            if second is not None:
                start_response(status_text, headers, held["exc_info"])
                return _Closing(_chain(first, _chain(second, it)), app_iter)
            rest = iter(())
        outcome = self.naulon.finish(facts, decision, code, tollable)
        if isinstance(outcome, Keep):
            names = {n.lower() for n, _ in outcome.add_headers}
            kept = [(n, v) for n, v in headers if n.lower() not in names] + outcome.add_headers
            start_response(status_text, kept, held["exc_info"])
            return _Closing(_chain(first, rest), app_iter)
        _close(app_iter)
        r = outcome.response
        start_response(_status_line(r.status), r.headers)
        return [r.body]


def _chain(first: bytes | None, rest: Iterator[bytes]) -> Iterator[bytes]:
    if first is not None:
        yield first
    yield from rest
