"""scope-cases.json: which paths are tolled, and under which slug, generated from slugForScope()."""

from __future__ import annotations

from typing import Any

import pytest
from conftest import fixture

from naulon.scope import slug_for_scope

DOC = fixture("scope-cases.json")


@pytest.mark.parametrize("i", range(len(DOC["scopes"])), ids=[s["name"] for s in DOC["scopes"]])
def test_scope(i: int) -> None:
    scope: dict[str, Any] = DOC["scopes"][i]["scope"]
    got = [slug_for_scope(p, scope) for p in DOC["paths"]]
    assert got == DOC["expect"][i]


@pytest.mark.parametrize("path", ["/essays/100%", "/essays/%zz", "/essays/%ff", "/essays/%ed%a0%80"])
def test_undecodable_key_reads_free(path: str) -> None:
    assert slug_for_scope(path, {"articlePrefixes": ["essays"]}) is None
