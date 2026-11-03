"""The gate's merged crawler-ranges document (`/.well-known/naulon/crawler-ranges.json`), validated
and compiled. A port of the PHP plugin's `Naulon_Ranges` read side. Any prefix broader than the
per-family minimum refuses the whole document, so a compromised gate cannot win partially."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from naulon import ip

FRESH_SECONDS = 604_800
MAX_BYTES = 2_097_152
KINDS = ("ranges", "signature", "none")


@dataclass(frozen=True)
class Operator:
    id: str
    operator: str
    fragments: tuple[str, ...]
    kind: str
    eligible: bool
    fetched_at: float | None
    set: tuple[ip.Cidr, ...]


@dataclass(frozen=True)
class Compiled:
    operators: Mapping[str, Operator]
    table: tuple[Operator, ...]
    proxies: Mapping[str, tuple[ip.Cidr, ...]]


def _strings(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(s, str) for s in v)


def _all_prefixes(v: Any) -> bool:
    return _strings(v) and all(ip.parse_cidr(s) is not None for s in v)


def validate(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    try:
        if len(json.dumps(raw)) > MAX_BYTES:
            return None
    except (TypeError, ValueError):
        return None
    if raw.get("version") != 1 or not isinstance(raw.get("generatedAt"), str):
        return None
    if not isinstance(raw.get("operators"), list) or not isinstance(raw.get("proxies"), dict):
        return None
    proxies: dict[str, list[str]] = {}
    for name, lst in raw["proxies"].items():
        if not _all_prefixes(lst) or not lst:
            return None
        proxies[str(name)] = list(lst)
    operators = []
    for o in raw["operators"]:
        if not isinstance(o, dict):
            return None
        if any(k not in o for k in ("id", "operator", "fragments", "prefixes", "kind", "forgedEligible")):
            return None
        if not isinstance(o["id"], str) or not isinstance(o["operator"], str):
            return None
        if not _strings(o["fragments"]) or not _all_prefixes(o["prefixes"]) or "" in o["fragments"]:
            return None
        if o["kind"] not in KINDS or not isinstance(o["forgedEligible"], bool):
            return None
        fetched = o.get("fetchedAt")
        if fetched is not None and not isinstance(fetched, str):
            return None
        operators.append(
            {
                "id": o["id"],
                "operator": o["operator"],
                "fragments": [f.lower() for f in o["fragments"]],
                "kind": o["kind"],
                "forgedEligible": o["forgedEligible"],
                "fetchedAt": fetched,
                "prefixes": list(o["prefixes"]),
            }
        )
    return {"version": 1, "generatedAt": raw["generatedAt"], "proxies": proxies, "operators": operators}


def _timestamp(s: str | None) -> float | None:
    if s is None:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def compile_doc(doc: Mapping[str, Any]) -> Compiled:
    table = tuple(
        Operator(
            id=o["id"],
            operator=o["operator"],
            fragments=tuple(o["fragments"]),
            kind=o["kind"],
            eligible=o["forgedEligible"],
            fetched_at=_timestamp(o["fetchedAt"]),
            set=tuple(ip.compile_prefixes(o["prefixes"])),
        )
        for o in doc["operators"]
    )
    return Compiled(
        operators={o.id: o for o in table},
        table=table,
        proxies={name: tuple(ip.compile_prefixes(lst)) for name, lst in doc["proxies"].items()},
    )


def is_fresh(op: Operator, now: float) -> bool:
    return op.fetched_at is not None and now - op.fetched_at <= FRESH_SECONDS


def proxy_sets(compiled: Compiled | None) -> Sequence[Sequence[ip.Cidr]]:
    return [] if compiled is None else list(compiled.proxies.values())
