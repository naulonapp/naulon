"""The outbound fetch guard, held to the same table and answers as `@naulon/sdk/net`."""

from __future__ import annotations

import pytest
from conftest import fixture

from naulon import ip

CASES = fixture("blocked-target-cases.json")


def test_the_blocked_table_is_the_fixtures() -> None:
    assert list(ip.BLOCKED) == CASES["ranges"]


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["address"])
def test_every_fixture_address_gets_the_fixtures_answer(case: dict[str, object]) -> None:
    text = str(case["address"]).strip("[]").split("%", 1)[0]
    parsed = ip.parse(text)
    assert (parsed is not None and ip.is_blocked_target(parsed)) is case["blocked"], text


def test_a_callers_own_address_over_6to4_is_still_that_caller() -> None:
    # RESERVED (who is calling) and BLOCKED (where a fetch may go) differ on purpose.
    a = ip.parse("2002:5db8:d822::1")
    assert a is not None and not ip.is_reserved(a) and ip.is_blocked_target(a)
