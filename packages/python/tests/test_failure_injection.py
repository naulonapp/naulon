"""Rule 1 and rule 10: whatever breaks inside naulon or the gate, a person's response is untouched
and nothing raises out of Naulon."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from conftest import AGENT_UA, BROWSER_UA, gate
from helpers import facts, naulon

from naulon import core, decide
from naulon.core import Continue, Keep
from naulon.transport import Response


def _timeout(*a: Any) -> None:
    return None


FAULTS: dict[str, Callable[[Any], None]] = {
    "timeout": lambda t: t.routes.update({p: None for p in list(t.routes)}),
    "500": lambda t: t.routes.update({p: Response(500, {}, b"boom") for p in list(t.routes)}),
    "malformed JSON": lambda t: t.routes.update({p: Response(200, {}, b"{not json") for p in list(t.routes)}),
    "DNS failure": lambda t: t.routes.update({p: _timeout for p in list(t.routes)}),
}


@pytest.mark.parametrize("fault", list(FAULTS))
def test_gate_faults_never_touch_a_person_and_never_raise(fault: str) -> None:
    t = gate()
    n = naulon(t)
    FAULTS[fault](t)
    n.config.refresh_now("blog.test")
    human = facts(BROWSER_UA)
    d = n.handle(human)
    assert n.finish(human, d, 200, True) == Keep()
    agent = facts(AGENT_UA, PAYMENT_SIGNATURE="signed")
    out = n.finish(agent, n.handle(agent), 200, True)
    assert isinstance(out, Keep), "a gate failure serves the agent too"


def test_an_exception_inside_decide_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    n = naulon(gate())

    def boom(*a: Any, **k: Any) -> Any:
        raise RuntimeError("bug")

    monkeypatch.setattr(core, "decide", boom)
    assert n.handle(facts(BROWSER_UA)) == Continue()
    assert n.handle(facts(AGENT_UA)) == Continue()


def test_an_exception_inside_the_queue_never_escapes(monkeypatch: pytest.MonkeyPatch) -> None:
    n = naulon(gate())

    def boom(*a: Any, **k: Any) -> None:
        raise RuntimeError("queue")

    monkeypatch.setattr(n.observations, "put", boom)
    f = facts(AGENT_UA)
    out = n.finish(f, n.handle(f), 200, True)
    assert out is not None


def test_an_exception_inside_finish_keeps_the_page(monkeypatch: pytest.MonkeyPatch) -> None:
    n = naulon(gate())

    def boom(*a: Any, **k: Any) -> Any:
        raise RuntimeError("client")

    monkeypatch.setattr(n.client, "quote", boom)
    f = facts(AGENT_UA)
    assert n.finish(f, n.handle(f), 200, True) == Keep()


def test_decide_never_raises_on_a_malformed_config() -> None:
    for doc in (
        {},
        {"enforcement": []},
        {"enforcement": {"gateScope": "site"}},
        {"enforcement": {}, "rules": []},
        {"enforcement": {"articlePrefixes": [1, None]}, "rules": {"block": "gptbot", "refuse": []}},
    ):
        decide.decide(facts(AGENT_UA), doc, None, 0)
