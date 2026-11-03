from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any
from wsgiref.util import setup_testing_defaults

from conftest import AGENT_UA, BROWSER_UA, gate
from helpers import naulon

from naulon.adapters.wsgi import NaulonWSGI


def environ(ua: str, path: str = "/hello/", **extra: str) -> dict[str, Any]:
    env: dict[str, Any] = {
        "PATH_INFO": path,
        "HTTP_HOST": "blog.test",
        "HTTP_USER_AGENT": ua,
        "HTTP_ACCEPT": "text/html" if ua == BROWSER_UA else "*/*",
        "REMOTE_ADDR": "203.0.114.9",
    }
    env.update(extra)
    setup_testing_defaults(env)
    return env


class App:
    def __init__(self, body: list[bytes] | Callable[[], Iterator[bytes]], status: str = "200 OK") -> None:
        self.body, self.status, self.closed = body, status, 0

    def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Any:
        start_response(self.status, [("Content-Type", "text/html")])
        app = self

        class It:
            def __iter__(self) -> Iterator[bytes]:
                return iter(app.body) if isinstance(app.body, list) else app.body()

            def close(self) -> None:
                app.closed += 1

        return It()


def run(mw: NaulonWSGI, env: dict[str, Any]) -> tuple[str, list[tuple[str, str]], bytes]:
    got: dict[str, Any] = {}

    def start_response(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Callable[[bytes], None]:
        got["status"], got["headers"] = status, headers
        return lambda b: None

    it = mw(env, start_response)
    body = b"".join(it)
    close = getattr(it, "close", None)
    if close:
        close()
    return got["status"], got["headers"], body


def test_a_person_gets_byte_identical_output() -> None:
    app = App([b"<p>article</p>"])
    bare = run(NaulonWSGI(app, naulon=None), environ(BROWSER_UA))  # type: ignore[arg-type]
    t = gate()
    wrapped = run(NaulonWSGI(app, naulon=naulon(t)), environ(BROWSER_UA))
    assert wrapped == bare and t.calls == []


def test_an_agent_on_an_article_gets_the_402_and_the_app_iterator_is_closed() -> None:
    app = App([b"<p>article</p>"])
    status, headers, body = run(NaulonWSGI(app, naulon=naulon(gate())), environ(AGENT_UA))
    assert status.startswith("402") and dict(headers)["PAYMENT-REQUIRED"] == "PAYREQ" and b"article" not in body
    assert app.closed == 1


def test_a_paid_agent_keeps_the_body_and_gains_the_receipt() -> None:
    app = App([b"<p>article</p>"])
    status, headers, body = run(NaulonWSGI(app, naulon=naulon(gate())), environ(AGENT_UA, HTTP_PAYMENT_SIGNATURE="s"))
    assert status.startswith("200") and body == b"<p>article</p>" and dict(headers)["PAYMENT-RESPONSE"] == "RECEIPT"
    assert app.closed == 1


def test_a_streaming_response_is_kept() -> None:
    def chunks() -> Iterator[bytes]:
        yield b"a"
        yield b"b"
        yield b"c"

    app = App(chunks)
    status, _, body = run(NaulonWSGI(app, naulon=naulon(gate())), environ(AGENT_UA))
    assert status.startswith("200") and body == b"abc" and app.closed == 1


def test_a_404_is_kept() -> None:
    app = App([b"nope"], "404 Not Found")
    status, _, body = run(NaulonWSGI(app, naulon=naulon(gate())), environ(AGENT_UA))
    assert status.startswith("404") and body == b"nope"


def test_close_is_called_on_the_app_iterator_for_a_person_too() -> None:
    app = App([b"x"])
    run(NaulonWSGI(app, naulon=naulon(gate())), environ(BROWSER_UA))
    assert app.closed == 1


def test_a_stream_that_is_not_an_article_is_never_held_for_a_second_chunk() -> None:
    pulled: list[int] = []

    def sse() -> Iterator[bytes]:
        yield b"data: hello\n\n"
        pulled.append(2)
        raise AssertionError("the second chunk must not be pulled before headers go out")

    class Stream(App):
        def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Any:
            start_response("200 OK", [("Content-Type", "text/event-stream")])
            return sse()

    got: dict[str, Any] = {}
    it = NaulonWSGI(Stream([]), naulon=naulon(gate()))(
        environ(AGENT_UA), lambda s, h, e=None: got.update(s=s) or (lambda b: None)
    )
    first = next(iter(it))
    assert got["s"].startswith("200") and first == b"data: hello\n\n" and pulled == []


def test_path_info_is_decoded_once() -> None:
    from naulon.adapters.wsgi import facts_of

    env = environ(AGENT_UA, "/blog/100%-off")
    assert facts_of(env).path == "/blog/100%25-off"
    from naulon.scope import slug_for_scope

    assert slug_for_scope(facts_of(env).path, {"articlePrefixes": ["blog"]}) == "100%-off"
