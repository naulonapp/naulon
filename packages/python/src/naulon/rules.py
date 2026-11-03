"""The publisher's rules (`rules` in `/_naulon/enforce-config`), applied in the gate's own order.

The gate sends them pre-resolved, so nothing here re-derives a rule. A port of the PHP plugin's
`Naulon_Rules::normalize` and `access`, held to `access-cases.json`.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from naulon.identity import Classified, Signals, Verdict, classify, classify_agent
from naulon.ranges import Compiled


@dataclass(frozen=True)
class Rules:
    block: tuple[str, ...] = ()
    allow: tuple[str, ...] = ()
    charge: tuple[str, ...] = ()
    refuse_crawlers: tuple[tuple[str, bool], ...] = ()
    refuse_agents: bool = False
    agent_reads_free: bool = False
    forged: Literal["charge", "block"] = "charge"
    identity_mode: Literal["auto", "off"] = "auto"
    toll_mode: Literal["charge", "observe"] = "charge"


@dataclass(frozen=True)
class IdentityContext:
    compiled: Compiled | None
    client_ip: str | None
    now: float
    armed: Collection[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Access:
    action: Literal["blocked", "free", "continue"]
    reason: str
    classified: Classified | None


def _list(v: Any) -> tuple[str, ...]:
    if not isinstance(v, list):
        return ()
    return tuple(i.strip().lower() for i in v if isinstance(i, str) and i.strip() != "")


def normalize(raw: Mapping[str, Any]) -> Rules:
    """A wire document as the decisions read it. Anything malformed becomes the empty rule, never a
    crash in a request path; a malformed `tollMode` charges, so it can never switch the toll off."""
    refuse = raw.get("refuse") if isinstance(raw.get("refuse"), dict) else {}
    assert isinstance(refuse, dict)
    crawlers = []
    rows = refuse.get("crawlers")
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, list) and len(row) >= 2 and isinstance(row[0], str) and row[0] != "":
                crawlers.append((row[0].lower(), row[1] is True))
    return Rules(
        block=_list(raw.get("block")),
        allow=_list(raw.get("allow")),
        charge=_list(raw.get("charge")),
        refuse_crawlers=tuple(crawlers),
        refuse_agents=refuse.get("agents") is True,
        agent_reads_free=raw.get("agentReadsFree") is True,
        forged="block" if raw.get("forged") == "block" else "charge",
        identity_mode="off" if raw.get("identityMode") == "off" else "auto",
        toll_mode="observe" if raw.get("tollMode") == "observe" else "charge",
    )


def blocked_by(ua: str, rules: Rules) -> str | None:
    lower = ua.lower()
    return next((f for f in rules.block if f in lower), None)


def refusal(ua: str, kind: str, rules: Rules) -> str | None:
    """Why the site's stated terms refuse this request, or None. The first registry fragment found
    decides, refused or not, which is how the gate recognises a crawler."""
    lower = ua.lower()
    for fragment, refused in rules.refuse_crawlers:
        if fragment in lower:
            if refused:
                return f"{fragment} is refused by this site's terms"
            break
    if kind == "agent" and rules.refuse_agents:
        return "this site refuses AI reading, so agent reads are not for sale"
    return None


def access(s: Signals, rules: Rules | None, identity: IdentityContext | None = None) -> Access:
    """1 blocked crawler, 2 classify (with the identity check), 2b an armed forged claim on a site
    set to block it, 3 a use the terms refuse, 4 a person reads free, 5 agent reads free by the
    terms, 6 otherwise continue to the price."""
    if rules is not None:
        fragment = blocked_by(s.user_agent, rules)
        if fragment is not None:
            return Access("blocked", f"crawler blocked by publisher ({fragment})", None)
    allow = rules.allow if rules is not None else ()
    charge = rules.charge if rules is not None else ()
    if identity is not None:
        result = classify(
            s,
            allow,
            charge,
            rules.identity_mode if rules is not None else "auto",
            identity.compiled,
            identity.client_ip,
            identity.now,
            identity.armed,
        )
    else:
        result = Classified(classify_agent(s, allow, charge), None, None)
    v: Verdict = result.verdict
    if v.forged and result.forged_claim is not None and rules is not None and rules.forged == "block":
        return Access("blocked", v.reason, result)
    if rules is not None:
        refused = refusal(s.user_agent, v.kind, rules)
        if refused is not None:
            return Access("blocked", refused, result)
    if v.kind == "human":
        return Access("free", f"human ({v.reason})", result)
    if rules is not None and rules.agent_reads_free:
        return Access("free", "agent (ai-input free by the site's terms)", result)
    return Access("continue", v.reason, result)
