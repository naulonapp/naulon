"""Person or agent, and does the caller's address back the crawler its user agent names.

A port of `packages/enforce/src/agentDetect.ts` and `identity.ts`, by way of the PHP plugin, held to
the same answers by `identity-cases.json` and `access-cases.json`.

The asymmetry behind every choice: flagging a person as an agent puts a person behind a paywall,
which breaks the product's one promise; flagging an agent as a person loses one micro-toll. So the
classifier charges only when confident, and ambiguity reads as a person.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from typing import Literal

from naulon import ip
from naulon.ranges import Compiled, Operator, is_fresh, proxy_sets

Kind = Literal["human", "agent"]
Check = Literal["signature", "ip-verified", "unverified", "forged"]

# Mirrors KNOWN_AGENT_UA in packages/enforce/src/agentDetect.ts. Search indexers are absent on
# purpose: tolling one deindexes the publisher.
KNOWN_AGENT_UA = (
    "gptbot", "chatgpt-user", "claudebot", "claude-user", "perplexitybot", "perplexity-user", "ccbot",
    "bytespider", "amazonbot", "applebot-extended", "meta-externalagent", "meta-externalfetcher",
    "amzn-user", "mistralai-user", "exasearchbot", "python-requests", "node-fetch", "axios", "curl",
    "wget", "langchain",
)  # fmt: skip

# The operator table used before a ranges document arrives: enough to recognise a claim and report
# it unverified. Mirrors CRAWLER_PROOF through `identity-cases.json` `operators`.
PROOF: tuple[dict[str, str | bool | list[str]], ...] = (
    {"id": "google", "operator": "Google", "fragments": ["googlebot"], "kind": "ranges", "forgedEligible": True},
    {"id": "bing", "operator": "Microsoft", "fragments": ["bingbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "duckduckgo", "operator": "DuckDuckGo", "fragments": ["duckduckbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "apple", "operator": "Apple", "fragments": ["applebot"], "kind": "ranges", "forgedEligible": True},
    {"id": "openai-gptbot", "operator": "OpenAI", "fragments": ["gptbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "openai-searchbot", "operator": "OpenAI", "fragments": ["oai-searchbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "openai-chatgpt-user", "operator": "OpenAI", "fragments": ["chatgpt-user"], "kind": "ranges", "forgedEligible": True},
    {"id": "anthropic", "operator": "Anthropic", "fragments": ["claudebot", "claude-user", "claude-searchbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "commoncrawl", "operator": "Common Crawl", "fragments": ["ccbot"], "kind": "ranges", "forgedEligible": True},
    {"id": "mistral", "operator": "Mistral", "fragments": ["mistralai-user"], "kind": "ranges", "forgedEligible": True},
    {"id": "perplexity-bot", "operator": "Perplexity", "fragments": ["perplexitybot"], "kind": "ranges", "forgedEligible": False},
    {"id": "perplexity-user", "operator": "Perplexity", "fragments": ["perplexity-user"], "kind": "ranges", "forgedEligible": False},
    {"id": "amazon", "operator": "Amazon", "fragments": ["amazonbot", "amzn-user"], "kind": "none", "forgedEligible": False},
    {"id": "exa", "operator": "Exa", "fragments": ["exasearchbot"], "kind": "signature", "forgedEligible": False},
    {"id": "meta", "operator": "Meta", "fragments": ["meta-externalagent", "meta-externalfetcher"], "kind": "none", "forgedEligible": False},
    {"id": "bytedance", "operator": "ByteDance", "fragments": ["bytespider"], "kind": "none", "forgedEligible": False},
)  # fmt: skip

# Which Web Bot Auth directory host speaks for which crawler fragment. Mirrors the `directoryHost`
# column of CRAWLER_REGISTRY through `botauth-vectors.json` `directories`, which test_botauth holds it to.
DIRECTORIES: tuple[tuple[str, str], ...] = (
    ("gptbot", "chatgpt.com"), ("meta-externalagent", "meta.com"), ("chatgpt-user", "chatgpt.com"),
    ("meta-externalfetcher", "meta.com"), ("exasearchbot", "crawler.exa.ai"), ("naulon-wayfarer", "naulon.app"),
    ("oai-searchbot", "chatgpt.com"), ("meta-webindexer", "meta.com"), ("ahrefsbot", "ahrefs.com"),
)  # fmt: skip

_RANK: dict[str, int] = {"signature": 0, "ip-verified": 1, "unverified": 2, "forged": 3}


@dataclass(frozen=True)
class Signals:
    user_agent: str = ""
    accept: str = ""
    has_payment_header: bool = False
    declared_agent_id: str = ""
    header_names: Collection[str] = field(default_factory=frozenset)
    # The directory host of a verified Web Bot Auth signature, when the request carried one.
    verified_agent: str | None = None


@dataclass(frozen=True)
class Claim:
    operator_id: str
    operator: str
    fragment: str
    check: Check = "unverified"


@dataclass(frozen=True)
class IdentityResult:
    check: Check
    claims: tuple[Claim, ...]

    def deciding_claim(self) -> Claim | None:
        return next((c for c in self.claims if c.check == self.check), None)


@dataclass(frozen=True)
class Verdict:
    kind: Kind
    reason: str
    confidence: float
    forged: bool = False


@dataclass(frozen=True)
class Classified:
    verdict: Verdict
    identity: IdentityResult | None
    forged_claim: Claim | None


def match_fragment(ua_lower: str, fragments: Sequence[str]) -> str | None:
    if ua_lower == "":
        return None
    for f in fragments:
        if isinstance(f, str) and f != "" and f.lower() in ua_lower:
            return f
    return None


def match_signer_host(host: str, fragments: Sequence[str]) -> str | None:
    """The first fragment `host` is, or is a subdomain of."""
    h = host.lower().rstrip(".")
    for f in fragments:
        frag = f.lower().rstrip(".")
        if frag and (h == frag or h.endswith(f".{frag}")):
            return f
    return None


def signer_backs(signer_host: str, fragment: str) -> bool:
    """Whether a verified signer speaks for a crawler fragment: its host is the directory the
    registry records for that fragment, or a subdomain of it."""
    return any(f == fragment and match_signer_host(signer_host, [d]) is not None for f, d in DIRECTORIES)


def classify_agent(
    s: Signals, allow: Sequence[str] = (), charge: Sequence[str] = (), forged_claim: Claim | None = None
) -> Verdict:
    """Declared intent, then the allowlist, then the charge list, then the built-in list, then
    browser shape, then the person default. The order is the kernel's and is load-bearing."""
    ua = s.user_agent.lower()
    if s.has_payment_header:
        return Verdict("agent", "presented x402 payment header", 0.99)
    if s.declared_agent_id:
        return Verdict("agent", f"declared agent id {s.declared_agent_id}", 0.95)
    if s.verified_agent:
        # A verified signature outranks every user-agent signal in both directions.
        va = s.verified_agent
        allowed_signer = match_signer_host(va, allow)
        if allowed_signer is not None:
            return Verdict("human", f'seo allowlist matched verified agent "{allowed_signer}"', 0.98)
        return Verdict("agent", f"verified web-bot-auth ({va})", 0.98)
    allowed = match_fragment(ua, allow)
    if allowed is not None and forged_claim is not None:
        return Verdict(
            "agent",
            f'claimed "{forged_claim.fragment}" from an address outside {forged_claim.operator}\'s published ranges',
            0.95,
            forged=True,
        )
    if allowed is not None:
        return Verdict("human", f'seo allowlist matched "{allowed}"', 0.9)
    charged = match_fragment(ua, charge)
    if charged is not None:
        return Verdict("agent", f'publisher charge policy matched "{charged}"', 0.8)
    hit = match_fragment(ua, KNOWN_AGENT_UA)
    if hit is not None:
        return Verdict("agent", f'user-agent matched "{hit}"', 0.8)
    if "text/html" in s.accept or "sec-fetch-mode" in s.header_names:
        return Verdict("human", "browser-shaped request", 0.85)
    return Verdict("human", "ambiguous; defaulting to human (free)", 0.4)


_PROOF_TABLE: tuple[tuple[str, str, tuple[str, ...]], ...] = tuple(
    (
        str(r["id"]),
        str(r["operator"]),
        tuple(f for f in r["fragments"] if isinstance(f, str)) if isinstance(r["fragments"], list) else (),
    )
    for r in PROOF
)


def _table(compiled: Compiled | None) -> Sequence[tuple[str, str, Sequence[str]]]:
    if compiled is None:
        return _PROOF_TABLE
    return [(o.id, o.operator, o.fragments) for o in compiled.table]


def claims_in(ua: str, compiled: Compiled | None) -> list[Claim]:
    lower = ua.lower()
    out = []
    for op_id, operator, fragments in _table(compiled):
        for f in fragments:
            if f != "" and f in lower:
                out.append(Claim(op_id, operator, f))
                break
    return out


def _claim_check(op: Operator | None, addr: ip.Addr | None, now: float) -> Check:
    if op is None or op.kind != "ranges" or addr is None:
        return "unverified"
    if ip.in_any(addr, op.set):
        return "ip-verified"
    if not op.eligible or not is_fresh(op, now):
        return "unverified"
    return "forged"


def check(
    ua: str, compiled: Compiled | None, client_ip: str | None, now: float, signer_host: str | None = None
) -> IdentityResult | None:
    """Each crawler claim in the user agent against the caller's address. Never accuses on missing
    evidence: no usable address, no ranges, stale ranges or an ineligible source read unverified."""
    found = claims_in(ua, compiled)
    if not found:
        return None
    addr = ip.parse_client_address(client_ip) if client_ip else None
    usable = addr is not None and ip.usable(addr, proxy_sets(compiled))
    claims = []
    worst: Check = "signature"
    for f in found:
        op = compiled.operators.get(f.operator_id) if compiled is not None else None
        c: Check = (
            "signature"
            if signer_host and signer_backs(signer_host, f.fragment)
            else _claim_check(op, addr if usable else None, now)
        )
        claims.append(Claim(f.operator_id, op.operator if op is not None else f.operator, f.fragment, c))
        if _RANK[c] > _RANK[worst]:
            worst = c
    return IdentityResult(worst, tuple(claims))


def classify(
    s: Signals,
    allow: Sequence[str],
    charge: Sequence[str],
    mode: str,
    compiled: Compiled | None,
    client_ip: str | None,
    now: float,
    armed: Collection[str],
) -> Classified:
    """Classify with the identity check applied. With mode `off` no claim is checked."""
    if mode == "off":
        return Classified(classify_agent(s, allow, charge), None, None)
    identity = check(s.user_agent, compiled, client_ip, now, s.verified_agent)
    forged = None
    if identity is not None:
        forged = next((c for c in identity.claims if c.check == "forged" and c.operator_id in armed), None)
    return Classified(classify_agent(s, allow, charge, forged), identity, forged)


def describe(result: IdentityResult | None) -> str:
    if result is None:
        return ""
    claim = result.deciding_claim()
    who = "the named crawler" if claim is None else claim.operator
    return {
        "ip-verified": f"address inside {who}'s published ranges",
        "forged": f"address outside {who}'s published ranges",
        "signature": f"signed by {who}",
    }.get(result.check, f"address not checked (no usable client address or no current ranges for {who})")
