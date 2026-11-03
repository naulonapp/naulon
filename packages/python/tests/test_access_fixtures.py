"""access-cases.json: the access decision for every crawler, terms combination and rule variant,
generated from the gate's decide()."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import fixture

from naulon.identity import Signals
from naulon.rules import access, normalize

DOC = fixture("access-cases.json")
CODES = {v: k for k, v in DOC["codes"].items()}


@pytest.mark.parametrize("s", DOC["subjects"], ids=[s["name"] for s in DOC["subjects"]])
def test_subject(s: dict[str, Any]) -> None:
    variants = DOC["variants"]
    disagree = []
    for t, rule_set in enumerate(DOC["ruleSets"]):
        for v, variant in enumerate(variants):
            raw = {k: (list(val) if isinstance(val, list) else val) for k, val in rule_set["rules"].items()}
            if variant != "none" and s["fragment"] is not None:
                raw[variant] = [*raw[variant], s["fragment"]]
            got = access(Signals(user_agent=s["ua"], accept=s["accept"]), normalize(raw)).action
            want = CODES[s["expect"][t * len(variants) + v]]
            if got != want:
                disagree.append(f"{rule_set['termsPolicy']} / {variant}: gate {want}, python {got}")
    assert disagree == []
