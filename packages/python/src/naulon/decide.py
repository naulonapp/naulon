"""What to do with a request, from the request and the cached policy alone. No network.

The answer is an action the core carries out: let it through, refuse it, or (for an agent on an
article) ask the gate after the view has run.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from naulon import identity as ident
from naulon import ip
from naulon.botauth import Outcome as Signature
from naulon.facts import RequestFacts
from naulon.identity import IdentityResult, Signals
from naulon.ranges import Compiled
from naulon.rules import IdentityContext, access, normalize
from naulon.scope import slug_for_scope

PAYMENT_HEADER = "payment-signature"
LICENSE_HEADER = "x-naulon-license"
PROOF_HEADER = "x-naulon-proof"
AGENT_ID_HEADER = "x-naulon-agent"
KIND_HEADER = "x-naulon-kind"

FreeReason = Literal["unpriced", "terms", "fleet", "unavailable"]
TollKind = Literal["read", "citation"]
_OPERATOR_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


@dataclass(frozen=True)
class Who:
    """How the classifier read the caller, for the observation report."""

    ua: str
    reason: str
    classified_as: Literal["human", "agent"] = "agent"
    identity: IdentityResult | None = None
    forged_from: str = ""
    # The Web Bot Auth result: the verified directory host, or a presented signature that failed.
    verified_agent: str | None = None
    sig_invalid: bool = False


@dataclass(frozen=True)
class Pass:
    """Serve untouched. `report` says whether the gate's audit plane should hear about it."""

    free: FreeReason | None = None
    report: bool = False
    slug: str = ""
    kind: TollKind = "read"
    who: Who | None = None


@dataclass(frozen=True)
class Refuse:
    status: int
    reason: str
    slug: str
    who: Who


@dataclass(frozen=True)
class Toll:
    """An agent on an article. Decided after the view: price it, settle a payment, or check a licence."""

    slug: str
    kind: TollKind
    who: Who
    payment: str = ""
    license: str = ""
    proof: str = ""
    observing: bool = False
    crawler_budget: Mapping[str, str] = field(default_factory=dict)


Action = Pass | Refuse | Toll


def _armed(config: Mapping[str, Any]) -> frozenset[str]:
    ids = config.get("identity", {}).get("armed") if isinstance(config.get("identity"), dict) else None
    if not isinstance(ids, list):
        return frozenset()
    return frozenset(i for i in ids if isinstance(i, str) and 0 < len(i) <= 64 and set(i) <= _OPERATOR_ID_CHARS)


SIGNATURE_HEADERS = ("signature-input", "signature", "signature-agent")


def decide(
    facts: RequestFacts,
    config: Mapping[str, Any] | None,
    compiled: Compiled | None,
    now: float,
    check_signature: Callable[[], Signature] | None = None,
) -> Action:
    """`config` is the host's `/_naulon/enforce-config` document, or None when there is none yet.
    `check_signature` verifies the request's Web Bot Auth signature; it is called only for a signed
    request on a tolled path, because it may fetch the signer's key directory."""
    if config is None or facts.method not in ("GET", "HEAD"):
        return Pass()
    enforcement = config.get("enforcement")
    if not isinstance(enforcement, dict):
        return Pass()
    slug = slug_for_scope(facts.path, enforcement)
    if slug is None:
        return Pass()
    raw_rules = config.get("rules")
    rules = normalize(raw_rules) if isinstance(raw_rules, dict) else None

    signature = None
    if check_signature is not None and all(facts.header(h) for h in SIGNATURE_HEADERS):
        signature = check_signature()
    verified = signature.agent if signature is not None and signature.status == "verified" else None

    ua = facts.header("user-agent")
    signals = Signals(
        user_agent=ua,
        accept=facts.header("accept"),
        has_payment_header=facts.header(PAYMENT_HEADER) != "",
        declared_agent_id=facts.header(AGENT_ID_HEADER),
        header_names=frozenset(facts.headers),
        verified_agent=verified,
    )
    # The caller's address is read only when the user agent names a crawler, so a person's request
    # never touches the identity check.
    ctx = None
    if verified or ident.claims_in(ua, compiled):
        ctx = IdentityContext(compiled=compiled, client_ip=facts.client_ip, now=now, armed=_armed(config))
    a = access(signals, rules, ctx)
    result = a.classified
    identity = result.identity if result is not None else None
    forged_from = ""
    if identity is not None and identity.check == "forged" and facts.client_ip:
        addr = ip.parse_client_address(facts.client_ip)
        forged_from = ip.truncate(addr) if addr is not None else ""
    kind: TollKind = "citation" if facts.header(KIND_HEADER).lower() == "citation" else "read"
    verdict = result.verdict if result is not None else None
    who = Who(
        ua=ua,
        reason=a.reason if a.action == "blocked" or verdict is None else verdict.reason,
        classified_as=verdict.kind if verdict is not None else "agent",
        identity=identity,
        forged_from=forged_from,
        verified_agent=verified,
        sig_invalid=signature is not None and signature.status == "invalid",
    )

    if a.action == "blocked":
        return Refuse(403, a.reason[:1].upper() + a.reason[1:] + ".", slug, who)
    if a.action == "free":
        if verdict is not None and verdict.kind == "human":
            # A person is never reported, unless the user agent named a crawler: the gate arms a
            # site's identity check from those rows.
            return Pass(report=identity is not None, slug=slug, kind=kind, who=who)
        return Pass(free="terms", report=True, slug=slug, kind=kind, who=who)

    observing = rules is not None and rules.toll_mode == "observe"
    return Toll(
        slug=slug,
        kind=kind,
        who=who,
        payment=facts.header(PAYMENT_HEADER),
        license=facts.header(LICENSE_HEADER),
        proof=facts.header(PROOF_HEADER),
        observing=observing,
        crawler_budget={k: facts.header(k) for k in ("crawler-max-price", "crawler-exact-price") if facts.header(k)},
    )
