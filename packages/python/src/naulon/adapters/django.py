"""Django middleware. Add `"naulon.adapters.django.NaulonMiddleware"` to `MIDDLEWARE`.

Settings come from `settings.NAULON` (`GATE`, `KEY`, `ENABLED`, `TIMEOUT`, `TOLLABLE`,
`CREDENTIAL_FOR`, `CONNECT`, `TRUST_PROXY_HEADERS`), with `NAULON_*` in the environment winning.
`TOLLABLE` is a dotted path to `tollable(request, response) -> bool`, which decides whether a response
is an article. It is called only for an agent, after the view ran, and only on a `200`.

`CREDENTIAL_FOR` is for a platform hosting many sites: a dotted path to
`credential_for(host) -> str | Site | None`, returning what that site's owner connected, or None for a
site that has not turned naulon on (see `naulon.sites`). It may query the ORM; under ASGI a cache miss
runs it through `sync_to_async`.

`CONNECT` is a dotted path to a `naulon.connect.Connect`. The middleware then answers the two connect
paths the gate fetches, before anything else and whether or not the site is tolled yet.

The view's own exceptions propagate untouched. A streaming or file response is never read and
never tolled.
"""

from __future__ import annotations

import dataclasses
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from asgiref.sync import iscoroutinefunction, markcoroutinefunction, sync_to_async
from django.conf import settings as django_settings
from django.http import HttpRequest, HttpResponse, HttpResponseBase
from django.utils.module_loading import import_string

from naulon._log import warn_error, warn_once
from naulon.connect import Connect, is_connect_path
from naulon.core import Continue, Decision, Keep, Naulon, Respond
from naulon.facts import RequestFacts, lower_headers
from naulon.settings import Settings
from naulon.sites import Site, SiteCredentials, _Miss

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


_UNSET = object()


def _imported(conf: dict[str, Any], name: str, broken: Any, consequence: str) -> Any:
    """The object a dotted-path setting names, `_UNSET` when the setting is absent, or `broken` (with
    one warning) when it names something that cannot be imported."""
    path = conf.get(name)
    if not (isinstance(path, str) and path):
        return _UNSET
    try:
        return import_string(path)
    except ImportError:
        warn_once(
            f"django.{name.lower()}", "naulon: NAULON['%s'] %s could not be imported; %s", name, path, consequence
        )
        return broken


def _setup() -> tuple[Naulon | None, Tollable, str | None, SiteCredentials]:
    """One Naulon per process, built on first use from settings."""
    with _lock:
        if "naulon" not in _state:
            conf = _config()
            settings = Settings.from_mapping(conf)
            hook = _imported(conf, "TOLLABLE", _never, "nothing is tolled")
            credential_for = _imported(conf, "CREDENTIAL_FOR", _nothing, "nothing is tolled")
            connect = _imported(conf, "CONNECT", None, "connect paths are not answered")
            proxy = conf.get("TRUST_PROXY_HEADERS")
            sites = SiteCredentials(settings.key, None if credential_for is _UNSET else credential_for)
            _state["sites"] = sites
            _state["naulon"] = Naulon(settings) if settings.active and sites.any else None
            _state["tollable"] = default_tollable if hook is _UNSET else hook
            _state["connect"] = connect if isinstance(connect, Connect) else None
            if connect is not _UNSET and connect is not None and not isinstance(connect, Connect):
                warn_once("django.connect", "naulon: NAULON['CONNECT'] is not a naulon.connect.Connect; ignored")
            _state["proxy"] = _meta_key(proxy) if isinstance(proxy, str) and proxy else None
        return _state["naulon"], _state["tollable"], _state["proxy"], _state["sites"]


def _nothing(host: str) -> str | Site | None:
    return None


def _handles(path: str) -> bool:
    """Cheap: whether the configured connect could answer this path at all."""
    if is_connect_path(path):
        return True
    _setup()
    connect: Connect | None = _state.get("connect")
    return connect is not None and connect.handles(path)


def _well_known(request: HttpRequest) -> HttpResponse | None:
    """The answer to a connect path, or None. Runs before the toll and whatever it decides."""
    _setup()
    connect: Connect | None = _state.get("connect")
    if connect is None:
        return None
    try:
        answer = connect.answer(
            request.scheme or "http",
            request.get_host(),
            request.path,
            request.method or "GET",
            str(request.META.get("QUERY_STRING", "")),
        )
    except Exception as err:
        warn_error("django.connect", "naulon: a connect path could not be answered", err)
        return None
    return None if answer is None else _to_django(Respond(answer.status, list(answer.headers), answer.body))


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


def _begin(request: HttpRequest) -> tuple[Naulon, RequestFacts, Tollable, SiteCredentials] | None:
    naulon, hook, proxy, sites = _setup()
    if naulon is None:
        return None
    return naulon, facts_of(request, proxy), hook, sites


def _decide(
    naulon: Naulon, facts: RequestFacts, hook: Tollable, sites: SiteCredentials, site: Site | None
) -> tuple[Naulon, RequestFacts, Decision, Tollable] | None:
    if sites.per_site and site is None:
        return None  # this site has not turned naulon on
    facts = dataclasses.replace(facts, site=site)
    return naulon, facts, naulon.handle(facts), hook


def _start(request: HttpRequest) -> tuple[Naulon, RequestFacts, Decision, Tollable] | None:
    try:
        begun = _begin(request)
        if begun is None:
            return None
        naulon, facts, hook, sites = begun
        return _decide(naulon, facts, hook, sites, sites.site(facts.host))
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


async def _astart(request: HttpRequest) -> tuple[Naulon, RequestFacts, Decision, Tollable] | None:
    """`_start` for an async stack: a `credential_for` cache miss may touch the ORM, so it runs in a
    thread."""
    try:
        begun = _begin(request)
        if begun is None:
            return None
        naulon, facts, hook, sites = begun
        site = sites.peek(facts.host)
        if isinstance(site, _Miss):
            site = await sync_to_async(sites.lookup)(facts.host)
        return _decide(naulon, facts, hook, sites, site)
    except Exception as err:
        warn_error("django.start", "naulon: request passed through after an internal error", err)
        return None


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
        answered = _well_known(request) if _handles(request.path) else None
        if answered is not None:
            return answered
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
        # A platform's connect store is its database, so the answer is looked up off the loop, and
        # only for the two paths it could be.
        if _handles(request.path):
            answered = await sync_to_async(_well_known)(request)
            if answered is not None:
                return answered
        started = await _astart(request)
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
