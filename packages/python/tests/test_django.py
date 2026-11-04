from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import django
import pytest
from conftest import AGENT_UA, BROWSER_UA, gate
from django.conf import settings

if not settings.configured:
    settings.configure(
        ALLOWED_HOSTS=["blog.test"], SECRET_KEY="test", DEFAULT_CHARSET="utf-8", USE_TZ=True, ROOT_URLCONF=__name__
    )
    django.setup()
urlpatterns: list[Any] = []

from django.http import HttpRequest, HttpResponse, StreamingHttpResponse  # noqa: E402
from django.test import RequestFactory  # noqa: E402

from naulon.adapters import django as adapter  # noqa: E402
from naulon.core import Naulon  # noqa: E402
from naulon.settings import Settings  # noqa: E402
from naulon.sites import SiteKeys  # noqa: E402

rf = RequestFactory()
TOLLED: list[tuple[HttpRequest, Any]] = []


def tollable(request: HttpRequest, response: Any) -> bool:
    TOLLED.append((request, response))
    return getattr(request, "naulon_post", None) is not None


@pytest.fixture(autouse=True)
def wired(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    adapter.reset()
    TOLLED.clear()
    t = gate()
    n = Naulon(Settings(gate="http://gate", key="k"), transport=t)
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config.refresh_now("blog.test", "k")
    n.config._refresh_ranges()
    t.calls.clear()
    monkeypatch.setattr(settings, "NAULON", {"TOLLABLE": f"{__name__}.tollable"}, raising=False)
    monkeypatch.setattr(adapter, "_setup", lambda: (n, tollable, None, SiteKeys("k")))
    yield t
    adapter.reset()


def get(ua: str, path: str = "/hello/", **extra: str) -> HttpRequest:
    accept = "text/html" if ua == BROWSER_UA else "*/*"
    return rf.get(path, HTTP_HOST="blog.test", HTTP_USER_AGENT=ua, HTTP_ACCEPT=accept, **extra)


def post_view(request: HttpRequest) -> HttpResponse:
    request.naulon_post = object()  # type: ignore[attr-defined]
    return HttpResponse("<p>the article</p>", content_type="text/html")


def test_a_person_gets_the_view_untouched_and_the_hook_is_never_called(wired: Any) -> None:
    res = adapter.NaulonMiddleware(post_view)(get(BROWSER_UA))
    assert res.status_code == 200 and res.content == b"<p>the article</p>"
    assert TOLLED == [] and wired.calls == []


def test_an_agent_on_a_post_gets_the_402() -> None:
    res = adapter.NaulonMiddleware(post_view)(get(AGENT_UA))
    assert res.status_code == 402 and res["PAYMENT-REQUIRED"] == "PAYREQ"
    assert res["Cache-Control"] == "private, no-store"


def test_a_paid_agent_gets_the_article_with_the_receipt() -> None:
    res = adapter.NaulonMiddleware(post_view)(get(AGENT_UA, HTTP_PAYMENT_SIGNATURE="signed"))
    assert res.status_code == 200 and res.content == b"<p>the article</p>"
    assert res["PAYMENT-RESPONSE"] == "RECEIPT"


def test_a_view_exception_propagates_unchanged() -> None:
    class Gone(Exception):
        pass

    def view(request: HttpRequest) -> HttpResponse:
        raise Gone("deleted blog")

    with pytest.raises(Gone, match="deleted blog"):
        adapter.NaulonMiddleware(view)(get(AGENT_UA))


def test_a_streaming_response_is_never_consumed_and_never_tolled() -> None:
    consumed: list[int] = []

    def chunks() -> Iterator[bytes]:
        consumed.append(1)
        yield b"a"

    def view(request: HttpRequest) -> StreamingHttpResponse:
        request.naulon_post = object()  # type: ignore[attr-defined]
        return StreamingHttpResponse(chunks())

    res = adapter.NaulonMiddleware(view)(get(AGENT_UA))
    assert res.status_code == 200 and consumed == []
    assert TOLLED == [], "the hook is not even asked"


def test_a_listing_or_a_404_is_never_tolled() -> None:
    def listing(request: HttpRequest) -> HttpResponse:
        return HttpResponse("<ul>posts</ul>", content_type="text/html")

    def missing(request: HttpRequest) -> HttpResponse:
        return HttpResponse("nope", status=404)

    assert adapter.NaulonMiddleware(listing)(get(AGENT_UA)).status_code == 200
    assert adapter.NaulonMiddleware(missing)(get(AGENT_UA)).status_code == 404


def test_the_async_path_behaves_like_the_sync_one() -> None:
    async def view(request: HttpRequest) -> HttpResponse:
        return post_view(request)

    mw = adapter.NaulonMiddleware(view)
    res = asyncio.run(mw(get(AGENT_UA)))
    assert res.status_code == 402
    res = asyncio.run(mw(get(BROWSER_UA)))
    assert res.status_code == 200 and res.content == b"<p>the article</p>"


def test_inactive_settings_return_the_view_and_nothing_else(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adapter, "_setup", lambda: (None, tollable, None, SiteKeys("k")))
    res = adapter.NaulonMiddleware(post_view)(get(AGENT_UA))
    assert res.status_code == 200 and TOLLED == []


def test_a_raising_hook_serves_the_page(monkeypatch: pytest.MonkeyPatch) -> None:
    n, _, _, _ = adapter._setup()

    def bad(request: HttpRequest, response: Any) -> bool:
        raise ValueError("hook bug")

    monkeypatch.setattr(adapter, "_setup", lambda: (n, bad, None, SiteKeys("k")))
    assert adapter.NaulonMiddleware(post_view)(get(AGENT_UA)).status_code == 200


def test_a_disallowed_host_passes_to_django_untouched() -> None:
    req = rf.get("/hello/", HTTP_HOST="evil.test", HTTP_USER_AGENT=AGENT_UA)
    assert adapter.NaulonMiddleware(post_view)(req).status_code == 200


def test_settings_and_trusted_proxy_header_are_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()
    adapter.reset()
    monkeypatch.setattr(
        settings, "NAULON", {"GATE": "http://gate", "KEY": "k", "TRUST_PROXY_HEADERS": "X-Real-IP"}, raising=False
    )
    n, hook, proxy, _ = adapter._setup()
    assert n is not None and n.settings.gate == "http://gate" and hook is adapter.default_tollable
    assert proxy == "HTTP_X_REAL_IP"
    req = rf.get("/x/", HTTP_HOST="blog.test", HTTP_X_REAL_IP="198.51.100.7", REMOTE_ADDR="10.0.0.2")
    assert adapter.facts_of(req, proxy).client_ip == "198.51.100.7"
    assert adapter.facts_of(req, None).client_ip == "10.0.0.2"


@pytest.mark.parametrize("header", ["X-Forwarded-For", "x-forwarded-for", "HTTP_X_FORWARDED_FOR", "Forwarded"])
def test_a_header_the_caller_can_append_to_is_never_trusted(header: str) -> None:
    assert adapter._meta_key(header) is None


def site_key_for(host: str) -> str | None:
    """A platform's lookup, as `NAULON['KEY_FOR']` names it."""
    return {"blog.test": "nln_site"}.get(host)


def test_key_for_is_read_from_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()
    adapter.reset()
    monkeypatch.setattr(
        settings, "NAULON", {"GATE": "http://gate", "KEY_FOR": f"{__name__}.site_key_for"}, raising=False
    )
    _, _, _, sites = adapter._setup()
    assert sites.per_site
    assert sites.key("blog.test") == "nln_site"
    assert sites.key("other.test") is None


def test_a_key_for_that_will_not_import_tolls_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.undo()
    adapter.reset()
    monkeypatch.setattr(
        settings, "NAULON", {"GATE": "http://gate", "KEY": "k", "KEY_FOR": "nope.missing"}, raising=False
    )
    _, _, _, sites = adapter._setup()
    assert sites.per_site and sites.key("blog.test") is None, "never the global key as a fallback"


def test_an_async_stack_tolls_under_the_site_key(monkeypatch: pytest.MonkeyPatch) -> None:
    t = gate()
    n = Naulon(Settings(gate="http://gate", key=None), transport=t)
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config.refresh_now("blog.test", "nln_site")
    n.config._refresh_ranges()
    monkeypatch.setattr(adapter, "_setup", lambda: (n, adapter.default_tollable, None, SiteKeys(None, site_key_for)))

    async def view(request: HttpRequest) -> HttpResponse:
        return post_view(request)

    req = rf.get("/hello/", HTTP_HOST="blog.test", HTTP_USER_AGENT=AGENT_UA)
    res = asyncio.run(adapter.NaulonMiddleware(view)(req))
    assert res.status_code == 402
