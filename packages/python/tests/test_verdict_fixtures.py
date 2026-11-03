"""verdict-cases.json: the gate's vocabularies and how an answer is read, generated from the gate."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import fixture

from naulon.client import GATE_VERDICTS, gate_answer
from naulon.decide import FreeReason

DOC = fixture("verdict-cases.json")


def test_the_verdicts_are_the_gates() -> None:
    assert list(GATE_VERDICTS) == DOC["gateVerdicts"]


def test_the_free_reasons_are_the_gates() -> None:
    assert list(FreeReason.__args__) == DOC["freeReasons"]  # type: ignore[attr-defined]


@pytest.mark.parametrize("c", DOC["cases"], ids=[c["name"] for c in DOC["cases"]])
def test_case(c: dict[str, Any]) -> None:
    assert gate_answer(c["status"], c["body"]) == c["verdict"]
