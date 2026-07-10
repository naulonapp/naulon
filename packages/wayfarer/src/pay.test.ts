/**
 * The mock buyer must complete a multi-leg (operator-fee) payment, not just the
 * single-author one. This stands up a faithful gate STUB (the wayfarer can't import
 * tollgate — one-way decoupling): it 402s with `naulonLegs` on the probe and only
 * serves content when the payment-signature is the full per-leg array. The same array
 * shape the real gate accepts in tollgate `payflow.test.ts`, so buyer-emits-shape +
 * gate-accepts-shape compose to a working fee'd payment.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockBuyer } from "./pay.ts";

const AUTHOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";

function feeGate402(): string {
  const authorReq = { network: "arc-testnet", asset: "0xUSDC", payTo: AUTHOR, amount: "10000", maxTimeoutSeconds: 691200, extra: { nonce: "author-nonce" } };
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/essays/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [authorReq],
      extensions: {
        naulonLegs: {
          version: 1,
          settlement: "author-sync-rest-deferred",
          legs: [
            { role: "author", payTo: AUTHOR, amount: "10000", nonce: "author-nonce" },
            { role: "operator", payTo: OPERATOR, amount: "500", nonce: "operator-nonce" },
          ],
        },
      },
    }),
  ).toString("base64");
}

test("mockBuyer signs every leg and unlocks a fee'd (operator-leg) resource", async () => {
  const real = globalThis.fetch;
  let signedLegCount = 0;
  // Gate stub: probe → 402 with naulonLegs; paid → only serve if all legs are signed.
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const sig = init?.headers?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": feeGate402() } });
    const parsed = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
    // The gate rejects an incomplete multi-leg payment (payflow.test.ts) — emulate that.
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return new Response(JSON.stringify({ error: "leg count mismatch" }), { status: 402 });
    }
    signedLegCount = parsed.length;
    return new Response("<html>origin</html>", { status: 200, headers: { "x-naulon-license": "lic.jws" } });
  }) as typeof globalThis.fetch;

  try {
    const result = await mockBuyer().fetch("https://x.test/essays/a", "read");
    assert.equal(result.ok, true, "the fee'd resource must unlock");
    assert.match(result.content ?? "", /origin/);
    assert.equal(result.license, "lic.jws");
    assert.equal(signedLegCount, 2, "the buyer must sign the author AND the operator leg");
  } finally {
    globalThis.fetch = real;
  }
});

// ── BUY-1.4 — the mock buyer honors the pay-time guard + classifies rejections ──

/** A 402 advertising a single author leg at `amount`. */
function priceGate402(amount: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/essays/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [{ network: "arc-testnet", asset: "0xUSDC", payTo: AUTHOR, amount, maxTimeoutSeconds: 120, extra: { nonce: "n" } }],
    }),
  ).toString("base64");
}

test("mockBuyer aborts (pays nothing) when the pay-time toll tops the guard ceiling", async () => {
  const real = globalThis.fetch;
  let paid = false;
  // The live toll is 20000, but the caller only authorized 10000 → the guard must abort
  // BEFORE any payment-signature POST.
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    if (init?.headers?.["payment-signature"]) {
      paid = true;
      return new Response("<html>origin</html>", { status: 200 });
    }
    return new Response(null, { status: 402, headers: { "payment-required": priceGate402("20000") } });
  }) as typeof globalThis.fetch;

  try {
    const result = await mockBuyer().fetch("https://x.test/essays/a", "read", { maxTotalAtomic: "10000" });
    assert.equal(result.ok, false, "a toll over the guard ceiling must not pay");
    assert.equal(result.errorCode, "toll_moved");
    assert.equal(result.retryable, true);
    assert.equal(paid, false, "no payment-signature was ever sent — nothing was spent");
  } finally {
    globalThis.fetch = real;
  }
});

test("mockBuyer classifies an insufficient-funds rejection as a non-retryable hard stop", async () => {
  const real = globalThis.fetch;
  // The gate accepts the probe but rejects the settled payment for insufficient balance.
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    if (init?.headers?.["payment-signature"]) {
      return new Response(JSON.stringify({ error: "settle failed: transfer amount exceeds balance" }), { status: 402 });
    }
    return new Response(null, { status: 402, headers: { "payment-required": priceGate402("10000") } });
  }) as typeof globalThis.fetch;

  try {
    const result = await mockBuyer().fetch("https://x.test/essays/a", "read");
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "insufficient_funds", "the balance signal is classified");
    assert.equal(result.retryable, false, "fund the wallet first — retrying as-is can't succeed");
    assert.match(result.error ?? "", /balance/i, "the raw gate reason is preserved for the human");
  } finally {
    globalThis.fetch = real;
  }
});

// ── buyer.fetch must not mistake a wrong path / down origin for a free read ────
// Before the fix, any non-402 (404, 5xx, 200) probe collapsed to `not_gated`, so
// paying a slug at the wrong /essays/ template on a /articles/ publisher looked
// like "this article is free" and the agent silently read nothing.

test("mockBuyer.fetch reports not_found (not not_gated) when the path 404s", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch;
  try {
    const result = await mockBuyer().fetch("https://x.test/essays/zeybek", "read");
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "not_found", "a 404 is a wrong/unknown path, not a free article");
    assert.match(result.error ?? "", /404|not found|canonical url/i, "the message must point the agent at the real url");
  } finally {
    globalThis.fetch = real;
  }
});

test("mockBuyer.fetch reports not_gated only for a genuine 2xx free read", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>free</html>", { status: 200 })) as typeof globalThis.fetch;
  try {
    const result = await mockBuyer().fetch("https://x.test/essays/a", "read");
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "not_gated", "a real 200 free read is the one true not_gated");
  } finally {
    globalThis.fetch = real;
  }
});

test("mockBuyer.fetch reports a retryable origin_error when the origin is down (5xx)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof globalThis.fetch;
  try {
    const result = await mockBuyer().fetch("https://x.test/essays/a", "read");
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "origin_error", "a 5xx is transient origin trouble, not a free read");
    assert.equal(result.retryable, true, "worth a retry once the origin recovers");
  } finally {
    globalThis.fetch = real;
  }
});
