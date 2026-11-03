"""The toll, in two phases around the host's own view.

`handle` runs before the view. It touches no network and short-circuits only a refusal.
`finish` runs after it, and only for an agent whose answer was an article (a `200` the host's
`tollable` hook accepted): there it prices, settles or checks a licence, and either keeps the
view's response (adding headers on a paid read) or replaces it with the 402.

Both phases are wrapped. Any exception inside naulon serves the request untouched and logs once a
minute at most: the host's page always wins.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from naulon import botauth
from naulon._log import warn_once
from naulon.client import FREE, Answer, Built, GateClient
from naulon.config import ConfigCache
from naulon.decide import Pass, Recheck, Refuse, Toll, Who, decide
from naulon.facts import RequestFacts
from naulon.observe import ObservationQueue
from naulon.settings import Settings
from naulon.transport import Breaker, Response, Transport, UrllibTransport

NO_STORE: tuple[tuple[str, str], ...] = (
    ("Cache-Control", "private, no-store"),
    ("Vary", "User-Agent, Accept, Authorization, Payment-Signature, X-Payment, X-Naulon-License"),
)
_PRICE = re.compile(r"\s*USD\s+(\d+)(?:\.(\d{1,6}))?\s*\Z", re.IGNORECASE)
MAX_UA = 512


@dataclass(frozen=True)
class Respond:
    status: int
    headers: list[tuple[str, str]]
    body: bytes


@dataclass(frozen=True)
class Continue:
    """Run the view. `pending` is what `finish` still has to do once the view has answered."""

    pending: Pass | Toll | Recheck | None = None


Decision = Continue | Respond


@dataclass(frozen=True)
class Keep:
    add_headers: list[tuple[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class Replace:
    response: Respond


Outcome = Keep | Replace

KEEP = Keep()


def _payment_required(built: Built, resource: str) -> Respond:
    import json

    return Respond(
        402,
        [("PAYMENT-REQUIRED", built.header), ("Content-Type", "application/json; charset=utf-8"), *NO_STORE],
        json.dumps({"error": "payment required", "resource": resource}).encode(),
    )


def _retry() -> Respond:
    return Respond(
        503,
        [("Retry-After", "2"), ("Content-Type", "application/json; charset=utf-8"), *NO_STORE],
        b'{"error":"pending"}',
    )


def _crawler_budget(declared: dict[str, str], ask_micro: int) -> str | None:
    for name in ("crawler-max-price", "crawler-exact-price"):
        m = _PRICE.match(declared.get(name, ""))
        if m:
            micro = int(m.group(1)) * 1_000_000 + int((m.group(2) or "").ljust(6, "0"))
            return "within" if micro >= ask_micro else "over"
    return None


class Naulon:
    def __init__(
        self,
        settings: Settings,
        transport: Transport | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        directory_fetch: Callable[[str], Response | None] = botauth.pinned_fetch,
    ) -> None:
        self.settings = settings
        self._wall = wall
        t = transport or UrllibTransport()
        breaker = Breaker(clock=clock)
        self.config = ConfigCache(settings, t, breaker, clock=clock)
        self.client = GateClient(settings, t, breaker, clock=clock)
        self.observations = ObservationQueue(self.client.observe, clock=clock)
        self._directory_fetch = directory_fetch
        self._directories = botauth.DirectoryCache(clock=clock)

    def _check_signature(self, facts: RequestFacts, may_fetch: bool) -> botauth.Outcome:
        """The request's Web Bot Auth result. Before the view (`may_fetch` False) it answers from the
        directory cache only, so no request thread or event loop waits on a signer's server."""
        req = botauth.SignedRequest(
            authority=facts.host,
            method=facts.method,
            path=facts.path,
            target_uri=facts.url + (f"?{facts.query}" if facts.query else ""),
            headers=facts.headers,
        )
        return botauth.verify(req, self._directory_fetch if may_fetch else None, self._directories, self._wall())

    # ── phase 1 ──────────────────────────────────────────────────────────────────────────────────

    def handle(self, facts: RequestFacts) -> Decision:
        if not self.settings.active:
            return Continue()
        try:
            doc = self.config.get(facts.host, facts.scheme)
            action = decide(
                facts, doc, self.config.ranges(), self._wall(), lambda: self._check_signature(facts, may_fetch=False)
            )
            if isinstance(action, Recheck):
                # A signer whose key directory is not cached yet: decided after the view, off the loop.
                return Continue(action)
            if isinstance(action, Refuse):
                self._report(facts, action.slug, "blocked", "read", action.who)
                return Respond(403, [("Content-Type", "text/plain; charset=utf-8"), *NO_STORE], action.reason.encode())
            if isinstance(action, Pass) and not action.report:
                return Continue()
            return Continue(action)
        except Exception as err:
            warn_once("core.handle", "naulon: request passed through after an internal error (%s)", type(err).__name__)
            return Continue()

    # ── phase 2 ──────────────────────────────────────────────────────────────────────────────────

    def finish(self, facts: RequestFacts, decision: Decision, status: int, tollable: bool) -> Outcome:
        if not isinstance(decision, Continue) or decision.pending is None:
            return KEEP
        # Rule 9: only an article is ever reported or tolled. A 404, a redirect, a listing or a
        # streaming response goes out untouched.
        if status != 200 or not tollable:
            return KEEP
        try:
            pending = decision.pending
            if isinstance(pending, Recheck):
                doc = self.config.get(facts.host, facts.scheme)
                again = decide(
                    facts, doc, self.config.ranges(), self._wall(), lambda: self._check_signature(facts, may_fetch=True)
                )
                if isinstance(again, Refuse):
                    self._report(facts, again.slug, "blocked", "read", again.who)
                    return Replace(
                        Respond(403, [("Content-Type", "text/plain; charset=utf-8"), *NO_STORE], again.reason.encode())
                    )
                if isinstance(again, Recheck) or (isinstance(again, Pass) and not again.report):
                    return KEEP
                pending = again
            if isinstance(pending, Pass):
                self._report(facts, pending.slug, "served-free", pending.kind, pending.who, freeReason=pending.free)
                return KEEP
            return self._toll(facts, pending)
        except Exception as err:
            warn_once("core.finish", "naulon: the page was served after an internal error (%s)", type(err).__name__)
            return KEEP

    def _served_free(self, facts: RequestFacts, t: Toll, why: str) -> Outcome:
        self._report(facts, t.slug, "served-free", t.kind, t.who, freeReason=why)
        return Keep(list(NO_STORE))

    def _toll(self, facts: RequestFacts, t: Toll) -> Outcome:
        resource = facts.url
        if t.license:
            checked = self.client.license_check(t.license, resource, t.slug, t.kind, t.proof)
            if checked.verdict is None or checked.verdict == "unavailable":
                return self._served_free(facts, t, "unavailable")
            if checked.verdict == "pending":
                return Replace(_retry())
            if checked.verdict == "paid":
                self._report(facts, t.slug, "agent-reread", t.kind, t.who)
                return Keep(list(NO_STORE))
            # refused: the licence did not pay for this read, so it is for sale like any other.

        built = self.client.quote(resource, t.slug, t.kind, t.who.verified_agent)
        if built is None:
            return self._served_free(facts, t, "unavailable")
        if built is FREE:
            self._report(facts, t.slug, "served-free", t.kind, t.who, freeReason="unpriced")
            return KEEP
        assert isinstance(built, Built)
        ask = built.ask_micro
        budget = _crawler_budget(dict(t.crawler_budget), ask)
        if t.observing:
            # Observing never settles: the payment is not forwarded and no money moves.
            self._report(
                facts, t.slug, "denied", t.kind, t.who,
                priceMicro=ask, crawlerBudget=budget, observeOnly=True, paymentPresented=bool(t.payment) or None,
            )  # fmt: skip
            return Keep(list(NO_STORE))
        if not built.legs:
            # Nobody to pay. Only an observing site is quoted like that; a charging one reads free.
            self._report(facts, t.slug, "served-free", t.kind, t.who)
            return KEEP
        if not t.payment:
            self._report(facts, t.slug, "denied", t.kind, t.who, priceMicro=ask, crawlerBudget=budget)
            return Replace(_payment_required(built, resource))
        return self._settle(facts, t, built, ask)

    def _settle(self, facts: RequestFacts, t: Toll, built: Built, ask: int) -> Outcome:
        answer: Answer = self.client.settle(t.payment, built, facts.url, self._agent_block(t.who))
        if answer.verdict == "paid":
            # No report: the gate wrote `paid` from the settle it owns.
            headers = list(NO_STORE)
            for wire, name in (("responseHeader", "PAYMENT-RESPONSE"), ("licenseJws", "X-Naulon-License")):
                v = answer.body.get(wire)
                if isinstance(v, str) and v and _header_safe(v):
                    headers.append((name, v))
            return Keep(headers)
        if answer.verdict == "pending":
            return Replace(_retry())
        if answer.verdict == "unavailable":
            # The gate already recorded this read; reporting it again would count one outage twice.
            return Keep(list(NO_STORE))
        if answer.verdict is None:
            # Served whether or not the payment moved: billing again could charge twice.
            return self._served_free(facts, t, "unavailable")
        self._report(facts, t.slug, "denied", t.kind, t.who, priceMicro=ask)
        return Replace(_payment_required(built, facts.url))

    # ── reports ──────────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _agent_block(who: Who) -> dict[str, Any]:
        out: dict[str, Any] = {"classifyReason": who.reason}
        if who.ua:
            out["ua"] = who.ua[:MAX_UA]
        # A field is sent only when there is a verdict on it: omitted means unknown, `false` is a claim.
        if who.verified_agent:
            out["verified"] = True
            out["verifiedAgent"] = who.verified_agent
        if who.sig_invalid:
            out["sigInvalid"] = True
        return out

    def _report(self, facts: RequestFacts, slug: str, verdict: str, kind: str, who: Who | None, **extra: Any) -> None:
        try:
            identity = who.identity if who is not None else None
            obs: dict[str, Any] = {
                "resource": facts.url,
                "slug": slug,
                "verdict": verdict,
                # Only a report carrying its identity check may say `human`: the gate arms a site from those.
                "classifiedAs": "human"
                if identity is not None and who is not None and who.classified_as == "human"
                else "agent",
                "kind": "citation" if kind == "citation" else "read",
                "at": int(self._wall() * 1000),
            }
            if identity is not None:
                obs["identityCheck"] = identity.check
                claim = identity.deciding_claim()
                if claim is not None:
                    obs["claimedOperator"] = claim.operator_id
                if identity.check == "forged" and who is not None and who.forged_from:
                    obs["forgedFrom"] = who.forged_from
            for k, v in extra.items():
                if v is None or (k == "priceMicro" and v <= 0):
                    continue
                if k == "freeReason" and verdict != "served-free":
                    continue
                if k == "crawlerBudget" and verdict != "denied":
                    continue
                obs[k] = v
            if who is not None:
                obs["agent"] = self._agent_block(who)
            self.observations.put(obs)
        except Exception as err:
            warn_once("core.report", "naulon: a decision report was dropped (%s)", type(err).__name__)


def _header_safe(v: str) -> bool:
    return all(32 <= ord(c) < 127 for c in v)


__all__ = ["Continue", "Decision", "Keep", "Naulon", "Outcome", "Replace", "Respond"]
