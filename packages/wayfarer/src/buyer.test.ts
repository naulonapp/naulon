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
  probePrice,
  quotedTotalAtomic,
  tollMovedOrNull,
  type Quoted,
} from "./buyer.ts";

const AUTHOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const NET = "arc-testnet";
const ASSET = "0xUSDC";

/** A PAYMENT-REQUIRED header exactly as tollgate `build402` emits it (mock mode). */
function paymentRequiredHeader(opts: { withOperatorLeg: boolean }): string {
  const authorReq = {
    network: NET,
    asset: ASSET,
    payTo: AUTHOR,
    amount: "10000",
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
