"""Every identity case tagged `python` in identity-cases.json, the file the TS and PHP runners read."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from conftest import fixture

from naulon import identity, ranges
from naulon.identity import Signals

NOW = 1790812800  # 2026-10-01T00:00:00Z, the TS runner's NOW.
DOC = fixture("identity-cases.json")


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def doc_for(c: dict[str, Any]) -> dict[str, Any] | None:
    """Mirrors docFor() in the TS runner."""
    if c["ranges"] is None:
        return None
    over = {o["id"]: o for o in c["ranges"]["operators"]}
    ops = []
    for r in DOC["operators"]:
        o = over.get(r["id"])
        ago = o.get("fetchedAgoHours") if o else None
        ops.append(
            {
                "id": r["id"],
                "operator": r["operator"],
                "fragments": r["fragments"],
                "kind": r["kind"],
                "forgedEligible": o["forgedEligible"] if o and "forgedEligible" in o else r["forgedEligible"],
                "fetchedAt": _iso(NOW - ago * 3600) if ago is not None else None,
                "prefixes": o["prefixes"] if o else [],
            }
        )
    return {"version": 1, "generatedAt": _iso(NOW), "proxies": {"cloudflare": ["173.245.48.0/20"]}, "operators": ops}


def test_built_in_table_mirrors_the_fixture_operators() -> None:
    assert [dict(r) for r in identity.PROOF] == DOC["operators"]


CASES = [c for c in DOC["cases"] if "python" in c["runtimes"]]


@pytest.mark.parametrize("c", CASES, ids=[c["name"] for c in CASES])
def test_case(c: dict[str, Any]) -> None:
    raw = doc_for(c)
    compiled = None
    if raw is not None:
        valid = ranges.validate(raw)
        assert valid is not None
        compiled = ranges.compile_doc(valid)
    headers = {k.lower() for k in c.get("headers", {})}
    out = identity.classify(
        Signals(user_agent=c["ua"], accept=c["accept"], header_names=headers, verified_agent=c.get("signedBy")),
        c["allow"],
        c.get("charge", []),
        c["mode"],
        compiled,
        c["clientIp"],
        NOW,
        c["armed"],
    )
    assert out.verdict.kind == c["expect"]["kind"]
    assert (out.identity.check if out.identity else None) == c["expect"]["identityCheck"]
    assert out.verdict.forged == c["expect"].get("forged", False)


def test_every_case_is_tagged_python() -> None:
    assert [c["name"] for c in DOC["cases"] if "python" not in c["runtimes"]] == []


def test_the_signer_directories_are_the_registrys() -> None:
    assert [{"fragment": f, "directoryHost": d} for f, d in identity.DIRECTORIES] == fixture("botauth-vectors.json")[
        "directories"
    ]
