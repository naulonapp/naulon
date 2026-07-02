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
import { generatePrivateKey } from "viem/accounts";

process.env.SETTLEMENT_NETWORK = "baseSepolia";
process.env.PAYMENT_MODE = "gateway";
process.env.LICENSES_ENABLED = "false"; // not exercising license minting here
process.env.BUYER_PRIVATE_KEY = generatePrivateKey(); // throwaway, never funded

const { gatewayBuyer } = await import("./gateway.ts");

const AUTHOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";

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
