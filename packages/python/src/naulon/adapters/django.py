"""Django middleware. Add `"naulon.adapters.django.NaulonMiddleware"` to `MIDDLEWARE`.

Settings come from `settings.NAULON` (`GATE`, `KEY`, `ENABLED`, `TIMEOUT`, `TOLLABLE`,
`TRUST_PROXY_HEADERS`), with `NAULON_*` in the environment winning. `TOLLABLE` is a dotted path to
`tollable(request, response) -> bool`, which decides whether a response is an article. It is called
only for an agent, after the view ran, and only on a `200`.

The view's own exceptions propagate untouched. A streaming or file response is never read and
never tolled.
"""

from __future__ import annotations

import threading
from collections.abc import Awaitable, Callable
from typing import Any

from asgiref.sync import iscoroutinefunction, markcoroutinefunction, sync_to_async
from django.conf import settings as django_settings
from django.http import HttpRequest, HttpResponse, HttpResponseBase
from django.utils.module_loading import import_string

from naulon._log import warn_error, warn_once
from naulon.core import Continue, Decision, Keep, Naulon, Respond
from naulon.facts import RequestFacts, lower_headers
from naulon.settings import Settings

Tollable = Callable[[HttpRequest, HttpResponseBase], bool]

_lock = threading.Lock()
_state: dict[str, Any] = {}


def default_tollable(request: HttpRequest, response: HttpResponseBase) -> bool:
    return (
        response.status_code == 200
        and not response.streaming
        and str(response.get("Content-Type", "")).startswith("text/html")
    )


def _config() -> dict[str, Any]:
    raw = getattr(django_settings, "NAULON", None)
    return dict(raw) if isinstance(raw, dict) else {}


def _setup() -> tuple[Naulon | None, Tollable, str | None]:
    """One Naulon per process, built on first use from settings."""
    with _lock:
        if "naulon" not in _state:
            conf = _config()
            settings = Settings.from_mapping(conf)
            hook: Tollable = default_tollable
            path = conf.get("TOLLABLE")
            if isinstance(path, str) and path:
                try:
                    hook = import_string(path)
                except ImportError:
                    warn_once(
                        "django.tollable",
                        "naulon: NAULON['TOLLABLE'] %s could not be imported; nothing is tolled",
                        path,
                    )
                    hook = _never
            proxy = conf.get("TRUST_PROXY_HEADERS")
            _state["naulon"] = Naulon(settings) if settings.active else None
            _state["tollable"] = hook
            _state["proxy"] = _meta_key(proxy) if isinstance(proxy, str) and proxy else None
        return _state["naulon"], _state["tollable"], _state["proxy"]


def _never(request: HttpRequest, response: HttpResponseBase) -> bool:
    return False


def reset() -> None:
    """Test seam: forget the per-process instance so changed settings are read again."""
    with _lock:
        _state.clear()


# A list the caller can prepend to: its first entry is whatever the caller sent, so trusting it would
# let a forger mark its own crawler claim verified. Same refusal as the WordPress plugin and the TS SDK.
_APPENDABLE = frozenset({"HTTP_X_FORWARDED_FOR", "HTTP_FORWARDED"})


def _meta_key(header: str) -> str | None:
    h = header.upper().replace("-", "_")
    key = h if h.startswith("HTTP_") or h == "REMOTE_ADDR" else f"HTTP_{h}"
    if key in _APPENDABLE:
        warn_once(
            "django.proxy", "naulon: TRUST_PROXY_HEADERS cannot be %s, which the caller can write; ignored", header
        )
        return None
    return key


def _client_ip(request: HttpRequest, proxy: str | None) -> str | None:
    """The caller's address: `REMOTE_ADDR`, or the single-value header a trusted proxy writes."""
    raw = request.META.get(proxy) if proxy else request.META.get("REMOTE_ADDR")
    if not isinstance(raw, str):
        return None
    first = raw.split(",", 1)[0].strip()
    return first or None


def facts_of(request: HttpRequest, proxy: str | None) -> RequestFacts:
    full = request.get_full_path()
    path, _, query = full.partition("?")
    return RequestFacts(
        method=request.method or "GET",
        scheme=request.scheme or "http",
        host=request.get_host(),
        path=path,
        query=query,
        headers=lower_headers(request.headers.items()),
        client_ip=_client_ip(request, proxy),
    )


def _to_django(r: Respond) -> HttpResponse:
    out = HttpResponse(r.body, status=r.status)
    for name, value in r.headers:
        out[name] = value
    return out


def _start(request: HttpRequest) -> tuple[Naulon, RequestFacts, Decision, Tollable] | None:
    try:
        naulon, hook, proxy = _setup()
        if naulon is None:
            return None
        facts = facts_of(request, proxy)
        return naulon, facts, naulon.handle(facts), hook
    except Exception as err:
        warn_error("django.start", "naulon: request passed through after an internal error", err)
        return None


def _is_tollable(hook: Tollable, request: HttpRequest, response: HttpResponseBase) -> bool:
    if response.status_code != 200 or response.streaming:
        return False
    try:
        return bool(hook(request, response))
    except Exception as err:
        warn_error("django.tollable_raised", "naulon: the tollable hook raised; not tolled", err)
        return False


def _apply(
    naulon: Naulon,
    facts: RequestFacts,
    decision: Decision,
    hook: Tollable,
    request: HttpRequest,
    response: HttpResponseBase,
) -> HttpResponseBase:
    try:
        outcome = naulon.finish(facts, decision, response.status_code, _is_tollable(hook, request, response))
        if isinstance(outcome, Keep):
            for name, value in outcome.add_headers:
                response[name] = value
            return response
        return _to_django(outcome.response)
    except Exception as err:
        warn_error("django.finish", "naulon: the page was served after an internal error", err)
        return response


class NaulonMiddleware:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response: Callable[[HttpRequest], Any]) -> None:
        self.get_response = get_response
        self._async = iscoroutinefunction(get_response)
        if self._async:
            markcoroutinefunction(self)

    def __call__(self, request: HttpRequest) -> Any:
        if self._async:
            return self.__acall__(request)
        started = _start(request)
        if started is None:
            return self.get_response(request)
        naulon, facts, decision, hook = started
        if isinstance(decision, Respond):
            return _to_django(decision)
        response = self.get_response(request)
        if not isinstance(decision, Continue) or decision.pending is None:
            return response
        return _apply(naulon, facts, decision, hook, request, response)

    async def __acall__(self, request: HttpRequest) -> HttpResponseBase:
        get_response: Callable[[HttpRequest], Awaitable[HttpResponseBase]] = self.get_response
        started = _start(request)
        if started is None:
            return await get_response(request)
        naulon, facts, decision, hook = started
        if isinstance(decision, Respond):
            return _to_django(decision)
        response = await get_response(request)
        if not isinstance(decision, Continue) or decision.pending is None:
            return response
        # `finish` asks the gate over the network, and the hook may touch the ORM: both off the loop.
        result: HttpResponseBase = await sync_to_async(_apply, thread_sensitive=False)(
            naulon, facts, decision, hook, request, response
        )
        return result
