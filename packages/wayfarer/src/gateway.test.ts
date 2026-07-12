/**
 * The Circle-SDK gateway buyer (Base rail) settles via `client.pay()`, which speaks
 * only stock x402 — it can't sign a naulon-extension N-leg array. Rather than silently
 * pay just the author leg (the gate would then 402 the read with a confusing
 * "leg count mismatch"), the buyer must REFUSE an operator-fee quote loudly and point
 * at the supported rail. The live fleet runs the memo (Arc) rail, which IS N-leg-capable
 * (see memo.test.ts); gateway N-leg is a documented follow-up.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.SETTLEMENT_NETWORK = "baseSepolia";
process.env.PAYMENT_MODE = "gateway";
process.env.LICENSES_ENABLED = "false"; // not exercising license minting here
process.env.BUYER_PRIVATE_KEY = generatePrivateKey(); // throwaway, never funded

const { gatewayBuyer } = await import("./gateway.ts");

const AUTHOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";
// A Gateway batching (single-author) 402 — `extra.name` "GatewayWalletBatched" is what the
// SDK's supportsBatching() keys on; `verifyingContract` is the GatewayWallet the buyer signs
// against (NOT the USDC token — the memo/gateway domain split that broke Base settle).
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"; // Circle GatewayWallet (base sepolia)
function gateway402(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532", // CAIP-2 — what the gate advertises (networks.ts); BatchEvmScheme requires it
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: AUTHOR,
          amount: "10000",
          maxTimeoutSeconds: 691200,
          extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET },
        },
      ],
    }),
  ).toString("base64");
}

function nLeg402(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [{ network: "base-sepolia", asset: "0xUSDC", payTo: AUTHOR, amount: "10000", maxTimeoutSeconds: 691200 }],
      extensions: {
        naulonLegs: {
          version: 1,
          settlement: "author-sync-rest-deferred",
          legs: [
            { role: "author", payTo: AUTHOR, amount: "10000" },
            { role: "operator", payTo: OPERATOR, amount: "500" },
          ],
        },
      },
    }),
  ).toString("base64");
}

test("gatewayBuyer refuses an N-leg (operator-fee) quote loudly instead of underpaying", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, { status: 402, headers: { "payment-required": nLeg402() } })) as typeof globalThis.fetch;
  try {
    const result = await gatewayBuyer().fetch("https://x.test/a", "read");
    assert.equal(result.ok, false, "an N-leg quote must not be silently single-leg-paid on the gateway rail");
    assert.match(result.error ?? "", /multi-leg|N-leg|memo/i);
  } finally {
    globalThis.fetch = real;
  }
});

test("gatewayBuyer signs the authorization with an INJECTED signer, not the env key", async () => {
  // The custody-free seam: the cloud passes a sign-only session signer; the env BUYER_PRIVATE_KEY
  // must never be read. Proof = the paid retry's `payment-signature` envelope carries the injected
  // signer's address as `authorization.from` (and the GatewayWallet-domain shape verify requires).
  const injected = privateKeyToAccount(generatePrivateKey()); // freshly generated, ≠ env key
  let paidHeader: string | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const sig = (init?.headers as Record<string, string> | undefined)?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": gateway402() } });
    paidHeader = sig; // the retry with the signed payment
    return new Response("PAID CONTENT", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const result = await gatewayBuyer(injected).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got: ${result.ok ? "" : result.error}`);
    assert.ok(paidHeader, "the buyer must retry with a payment-signature");
    const env = JSON.parse(Buffer.from(paidHeader!, "base64").toString("utf8")) as {
      payload: { authorization: { from: string } };
      resource: unknown;
      accepted: unknown;
    };
    assert.equal(
      env.payload.authorization.from.toLowerCase(),
      injected.address.toLowerCase(),
      "authorization.from must be the injected signer, never the env key",
    );
    assert.ok(env.resource && env.accepted, "envelope must carry resource + accepted (facilitator verify requires them)");
  } finally {
    globalThis.fetch = real;
  }
});

test("gatewayBuyer surfaces a network throw on the paid request as {ok:false} (origin_error), never rejects", async () => {
  // The paid retry can die at the socket (DNS failure, connection refused). fetch() must
  // return the typed failure like every other error path — a raw rejection would escape the
  // host's retry loop, which only ever inspects a resolved Fetched.
  const injected = privateKeyToAccount(generatePrivateKey());
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const sig = (init?.headers as Record<string, string> | undefined)?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": gateway402() } });
    throw new TypeError("fetch failed: ECONNREFUSED"); // the paid request dies at the socket
  }) as typeof globalThis.fetch;
  try {
    const result = await gatewayBuyer(injected).fetch("https://x.test/a", "read");
    assert.equal(result.ok, false, "a network throw on the paid request must be a typed failure, not a rejection");
    assert.equal(result.errorCode, "origin_error");
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = real;
  }
});

// ── Settlement-confirmation seam ─────────────────────────────────────────────
// A Gateway settle credits the payee's OFF-CHAIN Gateway balance, not their wallet, so
// `balanceOf(payee)` never moves and is the wrong check — the authoritative signal is the
// transfer's own status. `classifyGatewaySettlement` encodes that as code so callers can't
// fall back into the balanceOf trap.
const { classifyGatewaySettlement } = await import("./gateway.ts");

test("classifyGatewaySettlement: completed ⇒ settled", () => {
  assert.equal(classifyGatewaySettlement("completed"), "settled");
});

test("classifyGatewaySettlement: in-pipeline statuses ⇒ pending (not yet landed)", () => {
  for (const s of ["received", "batched", "confirmed"] as const) {
    assert.equal(classifyGatewaySettlement(s), "pending", `${s} must be pending`);
  }
});

test("classifyGatewaySettlement: failed ⇒ failed", () => {
  assert.equal(classifyGatewaySettlement("failed"), "failed");
});

test("classifyGatewaySettlement: an unknown/future status is treated as pending, never settled", () => {
  // Forward-compat: if Circle adds a status, never falsely report the money landed.
  assert.equal(classifyGatewaySettlement("some_future_status" as never), "pending");
});
