from __future__ import annotations

from typing import Any

from conftest import AGENT_UA, BROWSER_UA, FakeTransport

from naulon.core import Naulon
from naulon.facts import RequestFacts
from naulon.settings import Settings
from naulon.sites import Site

HOST = "blog.test"


def naulon(t: FakeTransport) -> Naulon:
    n = Naulon(Settings(gate="http://gate", key="k"), transport=t)
    n.observations._ensure_worker = lambda: None  # type: ignore[method-assign]
    n.config.refresh_now(HOST, Site("k"))
    # Warm the ranges too, so a later count of network calls sees only the request path.
    n.config._refresh_ranges(n.gates.home or "")
    t.calls.clear()
    return n


def facts(ua: str = AGENT_UA, path: str = "/hello/", method: str = "GET", **headers: str) -> RequestFacts:
    h: dict[str, Any] = {"user-agent": ua, "accept": "*/*" if ua != BROWSER_UA else "text/html", "host": HOST}
    h.update({k.replace("_", "-").lower(): v for k, v in headers.items()})
    return RequestFacts(method=method, scheme="http", host=HOST, path=path, headers=h, client_ip="203.0.114.9")


def reports(n: Naulon) -> list[dict[str, Any]]:
    return n.observations.queued()
