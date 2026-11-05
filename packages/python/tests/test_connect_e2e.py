"""Connect, end to end, over real sockets, against the real gate.

The gate and its console are the TypeScript ones (`conformance/connect-world.ts`, run as a
subprocess). The site is this package's middleware served by a real server: the ASGI adapter under
uvicorn, and Django through both its WSGI and its ASGI handler. The owner's browser is played by
following the redirects by hand, as the TypeScript e2e does.

Skipped, saying why, when Node or the workspace's node_modules are not there: this file proves the
two languages agree, so it cannot run on a checkout that has only one of them.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

import pytest

from naulon.adapters.asgi import NaulonASGI
from naulon.connect import Connect, Connected, Started
from naulon.settings import Settings

REPO = Path(__file__).resolve().parents[3]
WORLD = REPO / "conformance" / "connect-world.ts"
RETURN_PATH = "/naulon/connect/return"


@pytest.fixture(scope="module")
def world() -> Iterator[dict[str, str]]:
    if shutil.which("node") is None or not (REPO / "node_modules" / "tsx").is_dir():
        pytest.skip("connect e2e needs Node and the workspace's node_modules: run npm ci at the repo root")
    proc = subprocess.Popen(
        ["node", "--import", "tsx", str(WORLD)],
        cwd=REPO,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert proc.stdout is not None and proc.stdin is not None
    found: list[dict[str, str]] = []

    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("naulon-world "):
                found.append(json.loads(line[len("naulon-world ") :]))
                return

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    reader.join(60)
    if not found:
        proc.kill()
        pytest.fail("the gate world did not start within 60 s")
    try:
        yield found[0]
    finally:
        proc.stdin.close()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


def free_socket() -> socket.socket:
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    return s


def serve_asgi(app: Any) -> tuple[str, Callable[[], None]]:
    import uvicorn

    sock = free_socket()
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline:
            raise RuntimeError("uvicorn did not start")
        time.sleep(0.02)

    def stop() -> None:
        server.should_exit = True
        thread.join(10)

    return f"http://127.0.0.1:{sock.getsockname()[1]}", stop


class _Quiet(WSGIRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


class _Threaded(WSGIServer):
    # The console fetches the site while the test is still inside a request to the console, so the
    # site must answer concurrently with nothing else; one thread per request is enough.
    def process_request(self, request: Any, client_address: Any) -> None:
        threading.Thread(target=self._handle, args=(request, client_address), daemon=True).start()

    def _handle(self, request: Any, client_address: Any) -> None:
        try:
            self.finish_request(request, client_address)
        finally:
            self.shutdown_request(request)


def serve_wsgi(app: Any) -> tuple[str, Callable[[], None]]:
    server = make_server("127.0.0.1", 0, app, server_class=_Threaded, handler_class=_Quiet)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop() -> None:
        server.shutdown()
        server.server_close()

    return f"http://127.0.0.1:{server.server_port}", stop


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def get(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 - loopback test servers
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def owner(authorize_url: str, decision: str) -> tuple[int, str, str | None]:
    """The owner's browser: open the approve page, press a button, read where it sends them."""
    # The console's own Continue: a local console fetches nothing for a cross-site arrival.
    status, page = get(authorize_url, {"sec-fetch-site": "same-origin"})
    fields = {
        m[0]: html.unescape(m[1]) for m in re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)">', page)
    }
    fields["decision"] = decision
    post = urllib.request.Request(
        urllib.parse.urljoin(authorize_url, "/connect/authorize"),
        data=urllib.parse.urlencode(fields).encode(),
        headers={"content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin"},
        method="POST",
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(post, timeout=15)
        home = None
    except urllib.error.HTTPError as e:
        home = e.headers.get("location") if e.code == 303 else None
    return status, page, home


def assert_connects(world: dict[str, str], site: str, connect: Connect, saved: dict[str, Any]) -> None:
    """Start to credential, then prove the gate accepts the credential on this site alone."""
    started = connect.start(site)
    assert isinstance(started, Started), started
    assert started.url.startswith(f"{world['console']}/connect/authorize?"), started.url

    status, page, home = owner(started.url, "approve")
    assert status == 200, page
    assert "answered this request just now" in page
    assert home is not None and home.startswith(f"{site}{RETURN_PATH}?"), home

    assert get(home) == (200, "connected")
    done = saved["done"]
    assert isinstance(done, Connected), done
    assert done.site == site and done.gate == world["gate"]
    assert re.fullmatch(r"nln_site_[0-9A-Za-z]{43}", done.credential)

    bearer = {"authorization": f"Bearer {done.credential}"}
    assert get(f"{world['gate']}/_naulon/enforce-status", bearer)[0] == 200
    elsewhere = urllib.parse.quote("https://somebody-else.example.com/essays/x", safe="")
    assert get(f"{world['gate']}/_naulon/enforce-config?resource={elsewhere}", bearer)[0] == 401

    # The return link is spent: following it again connects nothing.
    assert get(home)[1] != "connected"


# ── the ASGI adapter under uvicorn ───────────────────────────────────────────────────────────────


def asgi_site(gate: str) -> tuple[Connect, dict[str, Any], Any]:
    connect = Connect("Python ASGI blog", gate=gate)
    saved: dict[str, Any] = {}

    async def inner(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["path"] == RETURN_PATH:
            query = dict(urllib.parse.parse_qsl(scope.get("query_string", b"").decode()))
            saved["done"] = await asyncio.to_thread(connect.finish, query)
            body = b"connected" if isinstance(saved["done"], Connected) else saved["done"].message.encode()
        else:
            body = b"<p>page</p>"
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": body})

    return connect, saved, NaulonASGI(inner, settings=Settings(gate=gate, key=None), connect=connect)


def test_an_asgi_site_connects_and_its_credential_works_there_alone(world: dict[str, str]) -> None:
    connect, saved, app = asgi_site(world["gate"])
    site, stop = serve_asgi(app)
    try:
        assert_connects(world, site, connect, saved)
    finally:
        stop()


def test_deny_brings_the_owner_home_with_nothing_issued(world: dict[str, str]) -> None:
    connect, saved, app = asgi_site(world["gate"])
    site, stop = serve_asgi(app)
    try:
        started = connect.start(site)
        assert isinstance(started, Started)
        _, _, home = owner(started.url, "deny")
        assert home is not None
        get(home)
        assert getattr(saved["done"], "error", None) == "denied"
    finally:
        stop()


def test_a_connect_started_for_someone_elses_site_never_reaches_approve(world: dict[str, str]) -> None:
    _, _, app = asgi_site(world["gate"])
    site, stop = serve_asgi(app)
    try:
        # A second runtime claims the running site's origin. That site never started this connect, so
        # it does not answer the challenge, and the console refuses before Approve exists.
        intruder = Connect("Not you", gate=world["gate"], client_id=lambda s: f"{site}/.well-known/naulon-client")
        started = intruder.start(site)
        assert isinstance(started, Started)
        status, page = get(started.url, {"sec-fetch-site": "same-origin"})
        assert status == 409, page
        assert "did not answer" in page
    finally:
        stop()


# ── Django, through its WSGI and its ASGI handler ────────────────────────────────────────────────

DJANGO_CONNECT: dict[str, Connect] = {}
DJANGO_SAVED: dict[str, Any] = {}


def connect_return(request: Any) -> Any:
    from django.http import HttpResponse

    done = DJANGO_CONNECT["c"].finish(request.GET)
    DJANGO_SAVED["done"] = done
    return HttpResponse("connected" if isinstance(done, Connected) else done.message, content_type="text/plain")


def _urls() -> list[Any]:
    from django.urls import path

    return [path(RETURN_PATH.lstrip("/"), connect_return)]


urlpatterns = _urls()


@pytest.fixture
def django_site(world: dict[str, str]) -> Iterator[None]:
    import django
    from django.conf import settings

    if not settings.configured:
        settings.configure(SECRET_KEY="test", USE_TZ=True, DEFAULT_CHARSET="utf-8")
        django.setup()
    from django.test.utils import override_settings

    from naulon.adapters import django as adapter

    DJANGO_CONNECT["c"] = Connect("Django blog", gate=world["gate"])
    DJANGO_SAVED.clear()
    adapter.reset()
    with override_settings(
        ALLOWED_HOSTS=["127.0.0.1"],
        ROOT_URLCONF=__name__,
        MIDDLEWARE=["naulon.adapters.django.NaulonMiddleware"],
        NAULON={"GATE": world["gate"], "CONNECT": f"{__name__}.django_connect"},
    ):
        yield
    adapter.reset()


def __getattr__(name: str) -> Any:
    # `NAULON["CONNECT"]` is a dotted path, read when the middleware sets up; the Connect it names is
    # made per test, against that test's gate.
    if name == "django_connect":
        return DJANGO_CONNECT["c"]
    raise AttributeError(name)


def test_a_django_wsgi_site_connects_and_its_credential_works_there_alone(
    world: dict[str, str], django_site: None
) -> None:
    from django.core.handlers.wsgi import WSGIHandler

    site, stop = serve_wsgi(WSGIHandler())
    try:
        assert_connects(world, site, DJANGO_CONNECT["c"], DJANGO_SAVED)
    finally:
        stop()


def test_a_django_asgi_site_connects_and_its_credential_works_there_alone(
    world: dict[str, str], django_site: None
) -> None:
    from django.core.handlers.asgi import ASGIHandler

    site, stop = serve_asgi(ASGIHandler())
    try:
        assert_connects(world, site, DJANGO_CONNECT["c"], DJANGO_SAVED)
    finally:
        stop()


# ── python -m naulon connect, beside a running WSGI app ───────────────────────────────────────────


def test_naulon_connect_beside_a_wsgi_app_finishes_in_the_app_and_tolls(world: dict[str, str], tmp_path: Path) -> None:
    import os
    import stat

    from naulon.adapters.wsgi import NaulonWSGI
    from naulon.local import LocalConnect, connect_main

    local = LocalConnect("My blog", gate=world["gate"], directory=tmp_path, environ={})

    def page(environ: dict[str, Any], start_response: Any) -> list[bytes]:
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"home"]

    app = NaulonWSGI(
        page,
        settings=Settings(gate=world["gate"], key=None),
        connect=local.connect,
        credential_for=local.credential_for,
    )
    site, stop = serve_wsgi(app)
    try:
        lines: list[str] = []
        seen = threading.Event()
        url: list[str] = []

        def out(line: str) -> None:
            lines.append(line)
            m = re.search(r"https?://\S+connect/authorize\S+", line)
            if m:
                url.append(m.group(0))
                seen.set()

        code: list[int] = []
        runner = threading.Thread(
            target=lambda: code.append(
                connect_main(
                    ["--site", site, "--gate", world["gate"], "--dir", str(tmp_path), "--timeout", "1"],
                    out=out,
                    err=lines.append,
                )
            ),
            daemon=True,
        )
        runner.start()
        assert seen.wait(30), lines
        status, page_html, home = owner(url[0], "approve")
        assert status == 200 and "My blog" in page_html, "the owner reads the app's own name"
        assert home is not None
        status, body = get(home)
        assert status == 200 and "Connected" in body
        runner.join(30)
        assert code == [0], lines

        cred_file = tmp_path / "credential"
        credential = cred_file.read_text().strip()
        assert re.fullmatch(r"nln_site_[0-9A-Za-z]{43}", credential)
        assert stat.S_IMODE(os.stat(cred_file).st_mode) == 0o600
        assert local.credential_for("anything") == credential, "the app picks it up with no restart"
        assert get(f"{world['gate']}/_naulon/enforce-status", {"authorization": f"Bearer {credential}"})[0] == 200
    finally:
        stop()
