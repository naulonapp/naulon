"""The calls an agent's request makes to the gate: the 402, settlement, and licence checks.

Everything that involves money or a signature is the gate's. This side never builds a payment
requirement, never converts an amount, and never decides whether a payment settled: it relays, and
reads the gate's `verdict`.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from naulon._log import warn_once
from naulon.config import key_digest
from naulon.settings import Settings
from naulon.transport import Breaker, Response, Transport

GateVerdict = Literal["paid", "refused", "pending", "unavailable"]
# Mirrors GATE_VERDICTS in @naulon/shared; test_verdict_fixtures holds it to verdict-cases.json.
GATE_VERDICTS: tuple[GateVerdict, ...] = ("paid", "refused", "pending", "unavailable")

QUOTE_TTL_S = 300.0
# Settlement verifies every leg on chain; it gets far longer than a lookup.
VERIFY_TIMEOUT_S = 60.0


@dataclass(frozen=True)
class Built:
    """A priced read: the `PAYMENT-REQUIRED` header the gate built, its legs, and the quote."""

    header: str
    legs: list[Any]
    quote: dict[str, Any]

    @property
    def ask_micro(self) -> int:
        if self.legs:
            return legs_total(self.legs)
        fees = 0
        extra = self.quote.get("extraLegs")
        if isinstance(extra, list):
            for leg in extra:
                amount = leg.get("amount") if isinstance(leg, dict) else None
                if isinstance(amount, str) and amount.isdigit():
                    fees += int(amount)
        return _micro_of(self.quote.get("price")) + fees


@dataclass(frozen=True)
class Answer:
    """A gate answer read by its verdict. `verdict` None is no verdict, which serves the page."""

    verdict: GateVerdict | None
    body: Mapping[str, Any]


FREE: Literal["free"] = "free"


def gate_answer(status: int, body: Any) -> GateVerdict | None:
    """What to do with an answer from /verify or /license/check, as `gateAnswer` in @naulon/shared
    reads it: the body's verdict when it has one; otherwise `refused` for a 4xx, and None (no
    verdict: serve the page) for anything else. `status` is 0 when no answer arrived.

    A 4xx without a verdict is refused because the agent can provoke one: its payment header can
    trip a body limit, a firewall or a rate limiter in front of the gate."""
    if isinstance(body, dict):
        v = body.get("verdict")
        for known in GATE_VERDICTS:
            if v == known:
                return known
    return "refused" if 400 <= status < 500 else None


def legs_total(legs: list[Any]) -> int:
    total = 0
    for leg in legs:
        req = leg.get("requirements") if isinstance(leg, dict) else None
        amount = req.get("amount") if isinstance(req, dict) else None
        if isinstance(amount, str) and amount.isdigit():
            total += int(amount)
        elif isinstance(amount, int) and not isinstance(amount, bool) and amount >= 0:
            total += amount
    return total


def _micro_of(price: Any) -> int:
    """A USDC float from the wire as integer micro-USDC, exactly (never through binary floats)."""
    if isinstance(price, bool) or not isinstance(price, (int, float, str)):
        return 0
    try:
        d = Decimal(str(price))
    except InvalidOperation:
        return 0
    if not d.is_finite() or d < 0:
        return 0
    return int((d * 1_000_000).to_integral_value())


def _carries_nonce(legs: list[Any]) -> bool:
    for leg in legs:
        req = leg.get("requirements") if isinstance(leg, dict) else None
        extra = req.get("extra") if isinstance(req, dict) else None
        if isinstance(extra, dict) and extra.get("nonce") not in (None, ""):
            return True
    return False


def _json(res: Response) -> Any:
    try:
        return json.loads(res.body)
    except ValueError:
        return None


class GateClient:
    def __init__(
        self, settings: Settings, transport: Transport, breaker: Breaker, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._s = settings
        self._t = transport
        self._b = breaker
        self._clock = clock
        self._quotes: dict[tuple[str, str, str], tuple[float, Built | Literal["free"]]] = {}
        self._lock = threading.Lock()

    def _call(
        self, method: str, path: str, site_key: str | None, body: Any = None, timeout: float | None = None
    ) -> Response | None:
        if self._s.gate is None:
            return None
        headers = {"accept": "application/json", "user-agent": "naulon-python"}
        if site_key:
            headers["authorization"] = f"Bearer {site_key}"
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode()
        # Asked last, after anything that can raise: a probe granted here is always recorded below,
        # or the breaker would stay half-open with nobody holding the probe.
        if not self._b.allow():
            return None
        res = self._t.request(
            method, f"{self._s.gate}{path}", headers=headers, body=data, timeout=timeout or self._s.timeout
        )
        self._b.record(res is not None and res.status < 500)
        if res is None:
            warn_once(
                f"gate.{path.split('?')[0]}", "naulon: the gate did not answer %s; serving the page", path.split("?")[0]
            )
        return res

    def quote(
        self, resource: str, slug: str, kind: str, verified_agent: str | None = None, site_key: str | None = None
    ) -> Built | Literal["free"] | None:
        """The built 402 for `resource`, "free" when the gate says it is not tolled (204), or None
        when no answer was usable (which serves the page)."""
        # A verified agent may be priced by its own rule, so its quote is cached apart.
        key = (
            resource.split("://", 1)[-1].split("/", 1)[0].lower() + "\x00" + slug + "\x00" + (verified_agent or ""),
            kind,
            key_digest(site_key),
        )
        now = self._clock()
        with self._lock:
            hit = self._quotes.get(key)
            if hit is not None and now - hit[0] < QUOTE_TTL_S:
                return hit[1]
        params = {"resource": resource, "slug": slug, "kind": kind, "build": "402", "observe": "1"}
        if verified_agent:
            params["verifiedAgent"] = verified_agent
        query = urllib.parse.urlencode(params)
        res = self._call("GET", f"/_naulon/quote?{query}", site_key)
        if res is None:
            return None
        if res.status == 204:
            self._remember(key, now, FREE)
            return FREE
        body = _json(res)
        x402 = body.get("x402") if res.status == 200 and isinstance(body, dict) else None
        if not isinstance(x402, dict) or not isinstance(x402.get("header"), str):
            return None
        assert isinstance(body, dict)
        quote = {k: v for k, v in body.items() if k != "x402"}
        legs = x402.get("legs") if isinstance(x402.get("legs"), list) else []
        assert isinstance(legs, list)
        built = Built(header=x402["header"], legs=legs, quote=quote)
        # Only a nonce-free 402 is the same for every caller. Nor a quote with nobody to pay: once
        # the owner adds a wallet, a cached empty quote would keep serving the page free.
        if legs and not _carries_nonce(legs):
            self._remember(key, now, built)
        return built

    def _remember(self, key: tuple[str, str, str], now: float, value: Built | Literal["free"]) -> None:
        with self._lock:
            if len(self._quotes) > 5_000:
                self._quotes.clear()
            self._quotes[key] = (now, value)

    def settle(
        self, payment: str, built: Built, resource: str, agent: Mapping[str, Any], site_key: str | None = None
    ) -> Answer:
        body = {
            "payment": payment,
            "legs": built.legs,
            "quote": built.quote,
            "resource": resource,
            "agent": dict(agent),
        }
        res = self._call("POST", "/_naulon/verify", site_key, body, timeout=VERIFY_TIMEOUT_S)
        return self._answer(res)

    def license_check(
        self, token: str, resource: str, slug: str, kind: str, proof: str, site_key: str | None = None
    ) -> Answer:
        body: dict[str, Any] = {"license": token, "resource": resource, "slug": slug, "kind": kind}
        if proof:
            body["proof"] = proof
        return self._answer(self._call("POST", "/_naulon/license/check", site_key, body))

    @staticmethod
    def _answer(res: Response | None) -> Answer:
        if res is None:
            return Answer(gate_answer(0, None), {})
        body = _json(res)
        return Answer(gate_answer(res.status, body), body if isinstance(body, dict) else {})

    def observe(self, site_key: str | None, reports: list[dict[str, Any]]) -> bool:
        res = self._call("POST", "/_naulon/observe", site_key, reports, timeout=max(self._s.timeout, 5.0))
        return res is not None and res.status < 500
