/**
 * The buyer must speak the N-leg toll, not just the single-author one. When a
 * publisher declares extra settlement legs (e.g. a control-plane operator fee), the
 * gate's 402 carries an `extensions.naulonLegs` block and REJECTS any payment that
 * doesn't sign every leg (see tollgate `payflow.test.ts`). With the fleet default fee
 * non-zero, that is the common case — so a single-leg-only buyer can pay almost nobody.
 *
 * These tests pin the two halves of the fix without crossing the package boundary
 * (the wayfarer depends on `shared`, never `tollgate`): `probePrice` must surface the
 * advertised legs, and `assemblePayment` must emit one signed payload per leg as the
 * ARRAY the gate parses — while staying byte-identical (a bare object) for a stock
 * single-author quote. The wire shapes here are exactly what tollgate `build402`
 * emits in mock mode and what the real gate accepts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assemblePayment,
  classifyPaymentError,
  classifySignerRefusal,
  payeeRefusedOrNull,
  probe,
  probePrice,
  quotedTotalAtomic,
  tollMovedOrNull,
  type Quoted,
} from "./buyer.ts";

const AUTHOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const NET = "arc-testnet";
const ASSET = "0xUSDC";

/** A PAYMENT-REQUIRED header exactly as tollgate `build402` emits it (mock mode).
 *  `amount` defaults to a stock "10000" (author leg) — override to pin an
 *  attacker-controlled/malformed toll amount without inventing a second header helper. */
function paymentRequiredHeader(opts: { withOperatorLeg: boolean; amount?: string }): string {
  const authorReq = {
    network: NET,
    asset: ASSET,
    payTo: AUTHOR,
    amount: opts.amount ?? "10000",
    maxTimeoutSeconds: 691200,
    extra: { nonce: "author-nonce" },
  };
  const body: Record<string, unknown> = {
    x402Version: 2,
    resource: { url: "https://x.test/essays/a", description: "naulon read toll: A", mimeType: "text/html" },
    accepts: [authorReq],
  };
  if (opts.withOperatorLeg) {
    body.extensions = {
      naulonLegs: {
        version: 1,
        settlement: "author-sync-rest-deferred",
        legs: [
          { role: "author", payTo: AUTHOR, amount: "10000", nonce: "author-nonce" },
          { role: "operator", payTo: OPERATOR, amount: "500", nonce: "operator-nonce" },
        ],
      },
    };
  }
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

/** Stub global fetch to return one 402 with the given PAYMENT-REQUIRED header. */
function stub402(header: string): typeof globalThis.fetch {
  return (async () =>
    new Response(null, { status: 402, headers: { "payment-required": header } })) as typeof globalThis.fetch;
}

test("probePrice surfaces NO legs for a stock single-author 402 (back-compat)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stub402(paymentRequiredHeader({ withOperatorLeg: false }));
  try {
    const quoted = await probePrice("https://x.test/essays/a", "read", "tester");
    assert.ok(quoted);
    assert.equal(quoted.legs, undefined, "a stock 402 has no extra legs");
    assert.equal(quoted.amountAtomic, "10000");
    assert.equal(quoted.priceUsdc, 0.01);
  } finally {
    globalThis.fetch = real;
  }
});

test("probePrice surfaces the advertised extra legs for an N-leg 402", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stub402(paymentRequiredHeader({ withOperatorLeg: true }));
  try {
    const quoted = await probePrice("https://x.test/essays/a", "read", "tester");
    assert.ok(quoted);
    assert.ok(quoted.legs, "the operator-fee 402 must surface its legs");
    assert.equal(quoted.legs.length, 2);
    assert.equal(quoted.legs[0]!.role, "author");
    assert.equal(quoted.legs[1]!.role, "operator");
    assert.equal(quoted.legs[1]!.payTo, OPERATOR);
    assert.equal(quoted.legs[1]!.amount, "500");
    assert.equal(quoted.legs[1]!.nonce, "operator-nonce");
    // The displayed price stays the AUTHOR leg — the content's price, the agent's
    // appraisal basis — not the buyer's fee-inclusive total.
    assert.equal(quoted.priceUsdc, 0.01);
  } finally {
    globalThis.fetch = real;
  }
});

test("assemblePayment emits a BARE object for a single-author quote (byte-identical)", async () => {
  const quoted: Quoted = {
    priceUsdc: 0.01,
    amountAtomic: "10000",
    nonce: "author-nonce",
    requirements: { network: NET, asset: ASSET, payTo: AUTHOR, amount: "10000", maxTimeoutSeconds: 691200 },
  };
  const sig = await assemblePayment(quoted, (req, nonce) => ({ payer: "0xPAYER", amount: req.amount, nonce }));
  const parsed = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
  assert.ok(!Array.isArray(parsed), "a single-leg payment stays a bare object (stock wire)");
  assert.equal(parsed.amount, "10000");
  assert.equal(parsed.nonce, "author-nonce");
});

test("assemblePayment signs every leg into the ARRAY the gate parses (leg order)", async () => {
  const quoted: Quoted = {
    priceUsdc: 0.01,
    amountAtomic: "10000",
    nonce: "author-nonce",
    requirements: { network: NET, asset: ASSET, payTo: AUTHOR, amount: "10000", maxTimeoutSeconds: 691200 },
    legs: [
      { role: "author", payTo: AUTHOR, amount: "10000", nonce: "author-nonce" },
      { role: "operator", payTo: OPERATOR, amount: "500", nonce: "operator-nonce" },
    ],
  };
  const sig = await assemblePayment(quoted, (req, nonce) => ({ payer: "0xPAYER", amount: req.amount, nonce, payTo: req.payTo }));
  const parsed = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
  assert.ok(Array.isArray(parsed), "a multi-leg payment is an array, one payload per leg");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].amount, "10000");
  assert.equal(parsed[0].payTo, AUTHOR);
  assert.equal(parsed[0].nonce, "author-nonce");
  assert.equal(parsed[1].amount, "500");
  assert.equal(parsed[1].payTo, OPERATOR);
  assert.equal(parsed[1].nonce, "operator-nonce");
});

// ── payee authorization — refuse a payTo no owner declared, before signing ─────
const singleQuote = (payTo: string): Quoted => ({
  priceUsdc: 0.01, amountAtomic: "10000", nonce: "author-nonce",
  requirements: { network: NET, asset: ASSET, payTo, amount: "10000", maxTimeoutSeconds: 691200 },
});
const multiQuote = (authorPayTo: string, opPayTo: string): Quoted => ({
  priceUsdc: 0.01, amountAtomic: "10000", nonce: "author-nonce",
  requirements: { network: NET, asset: ASSET, payTo: authorPayTo, amount: "10000", maxTimeoutSeconds: 691200 },
  legs: [
    { role: "author", payTo: authorPayTo, amount: "10000", nonce: "author-nonce" },
    { role: "operator", payTo: opPayTo, amount: "500", nonce: "operator-nonce" },
  ],
});

test("payeeRefusedOrNull: no guard / no authorizePayee ⇒ null (opt-in, unchanged)", async () => {
  assert.equal(await payeeRefusedOrNull(singleQuote(AUTHOR), undefined), null);
  assert.equal(await payeeRefusedOrNull(singleQuote(AUTHOR), { maxTotalAtomic: "10000" }), null);
});

test("payeeRefusedOrNull: single-leg authorized ⇒ null (clear to pay)", async () => {
  const r = await payeeRefusedOrNull(singleQuote(AUTHOR), { maxTotalAtomic: "10000", authorizePayee: (p) => p === AUTHOR });
  assert.equal(r, null);
});

test("payeeRefusedOrNull: single-leg UNauthorized ⇒ typed payee_refused (nothing signed)", async () => {
  const r = await payeeRefusedOrNull(singleQuote(OPERATOR), { maxTotalAtomic: "10000", authorizePayee: (p) => p === AUTHOR });
  assert.ok(r && !r.ok && r.errorCode === "payee_refused", `expected payee_refused, got ${JSON.stringify(r)}`);
  assert.equal(r.retryable, false);
});

test("payeeRefusedOrNull: multi-leg refuses if ANY leg's payTo is unauthorized", async () => {
  // author owned, operator NOT → whole quote refused
  const r = await payeeRefusedOrNull(multiQuote(AUTHOR, "0x9999999999999999999999999999999999999999"), {
    maxTotalAtomic: "10500", authorizePayee: (p) => p === AUTHOR,
  });
  assert.ok(r && !r.ok && r.errorCode === "payee_refused");
});

test("payeeRefusedOrNull: multi-leg all authorized ⇒ null", async () => {
  const r = await payeeRefusedOrNull(multiQuote(AUTHOR, OPERATOR), {
    maxTotalAtomic: "10500", authorizePayee: (p) => p === AUTHOR || p === OPERATOR,
  });
  assert.equal(r, null);
});

test("payeeRefusedOrNull: awaits an async authorizePayee", async () => {
  const r = await payeeRefusedOrNull(singleQuote(OPERATOR), {
    maxTotalAtomic: "10000", authorizePayee: async (p) => p === AUTHOR,
  });
  assert.ok(r && !r.ok && r.errorCode === "payee_refused");
});

// ── BUY-1.4 — pay-path failure-mode primitives ────────────────────────────────

const SINGLE: Quoted = {
  priceUsdc: 0.01,
  amountAtomic: "10000",
  nonce: "n",
  requirements: { network: NET, asset: ASSET, payTo: AUTHOR, amount: "10000", maxTimeoutSeconds: 120 },
};
const FEE: Quoted = {
  ...SINGLE,
  legs: [
    { role: "author", payTo: AUTHOR, amount: "10000", nonce: "a" },
    { role: "operator", payTo: OPERATOR, amount: "500", nonce: "o" },
  ],
};

test("quotedTotalAtomic uses the single author amount, or the SUM of every leg", () => {
  assert.equal(quotedTotalAtomic(SINGLE), 10000n, "single-author quote = its author amount");
  assert.equal(quotedTotalAtomic(FEE), 10500n, "N-leg quote = author + operator legs summed");
});

// A3-1 regression — the ceiling-check total and the SIGNED total must be the same number.
// assemblePayment only signs the `legs` array when length > 1; for a lone leg it signs
// `requirements`. If quotedTotalAtomic (the maxTotalAtomic guard) instead summed a lone
// leg, a gate could advertise a real price in requirements.amount and a fake-cheap
// single leg — the ceiling would pass on the cheap number while the buyer signs and pays
// the real one (pay-1000x-your-ceiling, defeating the guard on every rail).
const LONE_CHEAP_LEG: Quoted = {
  ...SINGLE,
  amountAtomic: "10000",
  requirements: { ...SINGLE.requirements, amount: "10000" },
  legs: [{ role: "author", payTo: AUTHOR, amount: "1", nonce: "a" }], // anomalous 1-elem array, $0.000001
};

async function signedTotalAtomic(q: Quoted): Promise<bigint> {
  const sig = await assemblePayment(q, (req) => ({ amount: req.amount }));
  const parsed = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  return payloads.reduce((s: bigint, p: { amount: string }) => s + BigInt(p.amount), 0n);
}

test("quotedTotalAtomic ALWAYS equals what assemblePayment signs (no ceiling/sign split-brain)", async () => {
  for (const q of [SINGLE, FEE, LONE_CHEAP_LEG]) {
    assert.equal(
      quotedTotalAtomic(q),
      await signedTotalAtomic(q),
      "the number checked against the ceiling must equal the number actually signed",
    );
  }
});

test("tollMovedOrNull passes a quote at/under the ceiling and aborts one over it", () => {
  assert.equal(tollMovedOrNull(SINGLE, undefined), null, "no guard → never aborts");
  assert.equal(tollMovedOrNull(SINGLE, { maxTotalAtomic: "10000" }), null, "exactly at the ceiling is fine");
  assert.equal(tollMovedOrNull(SINGLE, { maxTotalAtomic: "20000" }), null, "well under the ceiling is fine");

  const aborted = tollMovedOrNull(SINGLE, { maxTotalAtomic: "9999" });
  assert.ok(aborted, "a total over the ceiling aborts");
  assert.equal(aborted.ok, false);
  assert.equal(aborted.errorCode, "toll_moved");
  assert.equal(aborted.retryable, true, "a moved toll is worth re-quoting");
  assert.equal(aborted.paidUsdc, undefined, "an aborted pay spends nothing");

  // The guard is on the TRUE total across legs, so an operator fee counts against it.
  assert.equal(tollMovedOrNull(FEE, { maxTotalAtomic: "10000" })?.errorCode, "toll_moved", "fee leg pushes the total over the author-only ceiling");
  assert.equal(tollMovedOrNull(FEE, { maxTotalAtomic: "10500" }), null, "a ceiling covering both legs passes");
});

test("classifyPaymentError separates a fundable hard stop from a retryable rejection", () => {
  for (const msg of ["insufficient funds", "ERC20: transfer amount exceeds balance", "balance too low"]) {
    const c = classifyPaymentError(msg);
    assert.equal(c.errorCode, "insufficient_funds", `"${msg}" → insufficient_funds`);
    assert.equal(c.retryable, false, "insufficient funds is a hard stop — fund first, don't retry");
  }
  const exp = classifyPaymentError("authorization_validity_too_short");
  assert.equal(exp.errorCode, "expired");
  assert.equal(exp.retryable, true, "a validity/expiry rejection is retryable after re-quoting");

  const other = classifyPaymentError("nonce already used");
  assert.equal(other.errorCode, "rejected", "an unrecognized reason defaults to a generic rejection");
  assert.equal(other.retryable, true, "and stays retryable — never silently a hard stop");
});

// ── classifySignerRefusal() — a THROWN session-signer refusal, not a gate 402 ──
// The cloud injects a grant-checked session signer whose signTypedData THROWS on a
// refusal, message = the sign guard's code (optionally " (remaining <micro>)"). That
// throw never reached the gate, so nothing was paid — and it must not be run through
// classifyPaymentError (built for a 402 body): `grant_exceeded`/`no_session` fall
// through there to a retryable `rejected`, telling the agent to retry a doomed pay.
test("classifySignerRefusal maps fundable refusals to needs_topup (not retryable)", () => {
  for (const msg of ["grant_exceeded (remaining 0)", "no_session", "leg_too_large"]) {
    const c = classifySignerRefusal(msg);
    assert.equal(c?.errorCode, "needs_topup", `"${msg}" → needs_topup`);
    assert.equal(c?.retryable, false, "a top-up is the remedy — retrying without funding is doomed");
  }
});

test("classifySignerRefusal maps a lapsed grant to grant_expired (renew, not retryable)", () => {
  const c = classifySignerRefusal("grant_expired (remaining 4990000)");
  assert.equal(c?.errorCode, "grant_expired", "funds intact — the WINDOW lapsed; remedy is renew, not top-up");
  assert.equal(c?.retryable, false);
});

test("classifySignerRefusal maps a config refusal to a hard rejection (a top-up won't fix it)", () => {
  for (const msg of ["bad_from", "chain_mismatch", "payee_not_allowed"]) {
    const c = classifySignerRefusal(msg);
    assert.equal(c?.errorCode, "rejected", `"${msg}" → rejected`);
    assert.equal(c?.retryable, false);
  }
});

test("classifySignerRefusal maps the reserve's spend-envelope stops to needs_topup (not retryable)", () => {
  // sub_cap_exceeded (token cap) + daily_budget_exceeded (rolling 24h) are DETERMINISTIC reserve
  // refusals: the grant may be healthy, but this authorization can't clear the envelope. Retrying
  // re-signs the same amount into the same refusal — they must never fall through to
  // classifyPaymentError's retryable `rejected`, which is what made the /ask agent retry-loop.
  for (const msg of ["sub_cap_exceeded", "daily_budget_exceeded (remaining 0)"]) {
    const c = classifySignerRefusal(msg);
    assert.equal(c?.errorCode, "needs_topup", `"${msg}" → needs_topup`);
    assert.equal(c?.retryable, false, "a full spend envelope can't be cleared by retrying the same amount");
  }
});

test("classifySignerRefusal maps a policy/nonce refusal to a hard rejection (not retryable)", () => {
  // below_floor (buyer's own spam floor) + nonce_reused (the nonce is committed to another payment)
  // are deterministic: retrying the identical authorization only re-refuses. Before this they were
  // unrecognized → classifyPaymentError → retryable `rejected`, telling the agent to retry a doomed pay.
  for (const msg of ["below_floor", "nonce_reused"]) {
    const c = classifySignerRefusal(msg);
    assert.equal(c?.errorCode, "rejected", `"${msg}" → rejected`);
    assert.equal(c?.retryable, false);
  }
});

test("classifySignerRefusal returns null for a non-signer throw (caller maps origin_error)", () => {
  assert.equal(classifySignerRefusal("fetch failed: ECONNRESET"), null);
  assert.equal(classifySignerRefusal(""), null);
});

// ── probe() — classify the HTTP outcome, never collapse non-402 to "free" ──────
// The bug this pins: probePrice returned null for ANY non-402 (404, 5xx, 200),
// so a wrong path or a down origin was indistinguishable from a genuine free read.
// probe() must classify the outcome so callers stop treating a 404 as free content.

/** Stub global fetch to return one Response with the given status/headers/body. */
function stubStatus(status: number, opts: { header?: string; body?: string } = {}): typeof globalThis.fetch {
  const headers: Record<string, string> = {};
  if (opts.header !== undefined) headers["payment-required"] = opts.header;
  return (async () => new Response(opts.body ?? null, { status, headers })) as typeof globalThis.fetch;
}

async function withFetch<T>(f: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("probe classifies a valid 402 as gated with the decoded quote", async () => {
  await withFetch(stubStatus(402, { header: paymentRequiredHeader({ withOperatorLeg: false }) }), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "gated");
    if (o.status === "gated") assert.equal(o.quoted.amountAtomic, "10000");
  });
});

test("probe classifies a 2xx as a genuine free read (not an error)", async () => {
  await withFetch(stubStatus(200, { body: "<html>free</html>" }), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "free");
  });
});

test("probe classifies a 404 as not_found — NOT free (the /essays wrong-path footgun)", async () => {
  await withFetch(stubStatus(404), async () => {
    const o = await probe("https://x.test/essays/zeybek", "read", "tester");
    assert.equal(o.status, "not_found", "a 404 is a wrong/unknown path, not a free article");
    if (o.status === "not_found") assert.equal(o.httpStatus, 404);
  });
});

test("probe classifies a 5xx / 403 as unreachable (retryable origin trouble), not free", async () => {
  for (const status of [500, 502, 403]) {
    await withFetch(stubStatus(status), async () => {
      const o = await probe("https://x.test/essays/a", "read", "tester");
      assert.equal(o.status, "unreachable", `HTTP ${status} → unreachable`);
      if (o.status === "unreachable") assert.equal(o.httpStatus, status);
    });
  }
});

test("probe flags a 402 with no payment-required header as malformed (never silently free)", async () => {
  await withFetch(stubStatus(402), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "a 402 without the header is a broken gate, not a free read");
  });
});

test("probe flags a 402 with an empty accepts[] as malformed (no crash)", async () => {
  const emptyAccepts = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString("base64");
  await withFetch(stubStatus(402, { header: emptyAccepts }), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "an empty accepts list must not throw on accepts[0]");
  });
});

test("probe flags a 402 with an undecodable header as malformed (no throw)", async () => {
  await withFetch(stubStatus(402, { header: "@@@not-base64-json@@@" }), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed");
  });
});

// A2 — an attacker-controlled/untrusted gate (discovery is untrusted) can 402 with a
// bogus toll `amount`. Before this fix, probe() decoded it unvalidated into
// `priceUsdc: Number(req.amount) / 1e6`, and the FIRST caller to run that through
// `usdc()` (shared/src/types.ts) threw on non-finite/negative — which, inside run()'s
// price loop (agent.ts), aborted the whole loop and discarded every other candidate's
// price (attacker-controlled batch DoS). The toll amount must be validated at the
// source, in probe(), so every consumer inherits a safe value.
test("probe flags a 402 with a negative toll amount as malformed (never reaches usdc() unvalidated)", async () => {
  await withFetch(stub402(paymentRequiredHeader({ withOperatorLeg: false, amount: "-100" })), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "a negative toll amount is not a valid price — never silently gated");
  });
});

test("probe flags a 402 with a non-numeric toll amount as malformed (never reaches usdc() unvalidated)", async () => {
  await withFetch(stub402(paymentRequiredHeader({ withOperatorLeg: false, amount: "abc" })), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "a non-numeric toll amount is not a valid price — never silently gated");
  });
});

// A2 follow-up — `^\d+$` alone accepts an arbitrarily long digit string. A 402 with
// `amount: "9".repeat(310)` passes the regex, then `Number(amount)` overflows to
// `Infinity`, which `probe()` used to hand back as a "gated" quote with
// `priceUsdc: Infinity`. The FIRST caller to run that through `usdc()` (which throws on
// non-finite) crashes — the exact same batch-DoS class A2 closed, via a shape the regex
// didn't reject. The amount must be bounded so an overflowing value is malformed, not gated.
test("probe flags a 402 with an overflowing (all-digit) toll amount as malformed, not gated to Infinity", async () => {
  const overflow = "9".repeat(310);
  assert.equal(Number(overflow), Infinity, "sanity: this digit string does overflow to Infinity");
  await withFetch(stub402(paymentRequiredHeader({ withOperatorLeg: false, amount: overflow })), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "an overflow-to-Infinity amount must never reach usdc() as a gated quote");
  });
});

test("probe flags a 402 with a toll amount just past the digit-length cap as malformed", async () => {
  // 16 nines is comfortably past any real toll and past Number.MAX_SAFE_INTEGER's digit
  // count — the boundary just beyond the cap, still finite but absurd.
  const tooLong = "9".repeat(16);
  await withFetch(stub402(paymentRequiredHeader({ withOperatorLeg: false, amount: tooLong })), async () => {
    const o = await probe("https://x.test/essays/a", "read", "tester");
    assert.equal(o.status, "malformed", "a digit string past the magnitude cap must not be treated as a real toll");
  });
});

test("probePrice stays back-compatible: the gated quote for a 402, null for anything else", async () => {
  await withFetch(stubStatus(402, { header: paymentRequiredHeader({ withOperatorLeg: false }) }), async () => {
    assert.ok(await probePrice("https://x.test/essays/a", "read", "tester"), "402 → quote");
  });
  await withFetch(stubStatus(404), async () => {
    assert.equal(await probePrice("https://x.test/essays/a", "read", "tester"), null, "404 → null (legacy shape)");
  });
});
