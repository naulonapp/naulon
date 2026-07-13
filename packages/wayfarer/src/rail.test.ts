/**
 * railBuyer picks the settlement rail from the RECEIVED 402, not the fleet's activeNetwork().
 * The fleet default here is arcTestnet (memo-capable) throughout — so a gateway-shaped 402 that
 * still routes to the gateway signer proves the decision keys off the tenant's advertised rail,
 * which is the whole point of RAS-B (one buyer, a mixed fleet). Signers are real viem accounts
 * wrapped to record they were consulted, so the gateway path exercises the actual Circle SDK sign.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.SETTLEMENT_NETWORK = "arcTestnet"; // fleet default = memo-capable, on purpose
process.env.PAYMENT_MODE = "gateway";
process.env.LICENSES_ENABLED = "false";
process.env.BUYER_PRIVATE_KEY = generatePrivateKey(); // throwaway, never funded

const { railBuyer } = await import("./rail.ts");
const { activeNetwork, supportsMemo } = await import("@naulon/shared");

const AUTHOR = "0x1111111111111111111111111111111111111111";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"; // Circle GatewayWallet (base sepolia)

/** A single-author Gateway 402 — extra.name 'GatewayWalletBatched' is the gateway tell. */
function gateway402(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
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

/** A memo (Arc self-relay) 402 — no gateway extra; network is the fleet's own memo chain. */
function memo402(): string {
  const net = activeNetwork();
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [{ network: net.network, asset: net.usdc, payTo: AUTHOR, amount: "5000", maxTimeoutSeconds: 691200 }],
    }),
  ).toString("base64");
}

/** A real viem account wrapped to count how many times its signTypedData was consulted. */
function recorder() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const calls: unknown[] = [];
  return {
    calls,
    signer: {
      address: acct.address,
      async signTypedData(a: Parameters<typeof acct.signTypedData>[0]) {
        calls.push(a);
        return acct.signTypedData(a);
      },
    },
  };
}

/** Stub globalThis.fetch: the probe (no payment-signature) 402s with `header402`; the paid GET 200s. */
function stubFetch(header402: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const sig = (init?.headers as Record<string, string> | undefined)?.["payment-signature"];
    if (!sig) return new Response(null, { status: 402, headers: { "payment-required": header402 } });
    return new Response("PAID BODY", { status: 200 });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("railBuyer selects the GATEWAY builder when the 402 advertises GatewayWalletBatched", async () => {
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(gateway402());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(gw.calls.length >= 1, "the gateway signer must be consulted for a gateway 402");
    assert.equal(memo.calls.length, 0, "the memo signer must NOT be consulted for a gateway 402");
  } finally {
    restore();
  }
});

test("railBuyer selects the MEMO builder when the 402 has no gateway extra", async () => {
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(memo402());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(memo.calls.length >= 1, "the memo signer must be consulted for a memo 402");
    assert.equal(gw.calls.length, 0, "the gateway signer must NOT be consulted for a memo 402");
  } finally {
    restore();
  }
});

test("railBuyer decision is independent of activeNetwork() (gateway 402 under a memo-capable fleet)", async () => {
  assert.equal(supportsMemo(activeNetwork()), true, "precondition: the fleet default (arcTestnet) is memo-capable");
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(gateway402());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(gw.calls.length >= 1, "gateway must be chosen off the 402 even though the fleet is memo-capable");
    assert.equal(memo.calls.length, 0);
  } finally {
    restore();
  }
});

test("railBuyer returns a typed failure when the 402's rail has no matching signer", async () => {
  const memo = recorder();
  const restore = stubFetch(gateway402()); // gateway 402, but only a memo signer supplied
  try {
    const result = await railBuyer({ memo: memo.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, false, "a gateway 402 with no gateway signer must not silently succeed");
    assert.match(result.error ?? "", /gateway signer/i);
    assert.equal(memo.calls.length, 0, "the memo signer must not be consulted for a gateway 402");
  } finally {
    restore();
  }
});
