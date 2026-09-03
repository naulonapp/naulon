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

const { railBuyer, assembleRailPayment } = await import("./rail.ts");
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

/** The REAL gate shape on a memo chain: build402 stamps the GatewayWalletBatched descriptor into
 *  `extra` on every gateway-mode 402 — Arc included — while verifyAndSettle still settles it via
 *  the memo self-relay. The 2026-07-13 prod outage: railBuyer trusted the descriptor, signed the
 *  Gateway envelope, and the gate's memo settle rejected every pay ("malformed memo payload"). */
function memo402WithGatewayExtra(): string {
  const net = activeNetwork();
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
      accepts: [
        {
          scheme: "exact",
          network: net.network,
          asset: net.usdc,
          payTo: AUTHOR,
          amount: "5000",
          maxTimeoutSeconds: 691200,
          extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: net.gatewayWallet },
        },
      ],
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

test("PayGuard.authorizePayee: a refused payTo returns payee_refused, and NOTHING is signed", async () => {
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(memo402()); // pays AUTHOR
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read", {
      maxTotalAtomic: "1000000",
      authorizePayee: (payTo) => payTo !== AUTHOR, // refuse exactly the advertised payee
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "payee_refused", `expected payee_refused, got ${JSON.stringify(result)}`);
    assert.equal(memo.calls.length, 0, "an unauthorized payee must be refused BEFORE signing");
    assert.equal(gw.calls.length, 0);
  } finally {
    restore();
  }
});

test("PayGuard.authorizePayee: an authorized payTo pays as normal", async () => {
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(memo402());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read", {
      maxTotalAtomic: "1000000",
      authorizePayee: (payTo) => payTo === AUTHOR,
    });
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(memo.calls.length >= 1, "an authorized payee signs normally");
  } finally {
    restore();
  }
});

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

test("railBuyer picks MEMO for a memo-network 402 even when it carries the GatewayWalletBatched extra (the real gate shape)", async () => {
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(memo402WithGatewayExtra());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(memo.calls.length >= 1, "the memo signer must be consulted — the registry rail beats the extra tell");
    assert.equal(gw.calls.length, 0, "the gateway signer must NOT be consulted for a known memo network");
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

/* ── assembleRailPayment: the same rail pick, without the fetch loop ──────────
 * A host that already HOLDS a 402 it built itself (the cloud selling a licence it just offered)
 * needs to sign it with the buyer's session signers and nothing else — no probe, no paid GET. It
 * must pick the rail exactly as railBuyer does, or the sale and the toll drift on which envelope
 * a tenant's chain gets. */

const FEE = "0x7777777777777777777777777777777777777777";

function memoQuoted(legs: { payTo: string; amount: string }[]): Parameters<typeof assembleRailPayment>[0] {
  const net = activeNetwork();
  const first = legs[0]!;
  return {
    priceUsdc: 0,
    amountAtomic: first.amount,
    requirements: { network: net.network, asset: net.usdc, payTo: first.payTo, amount: first.amount, maxTimeoutSeconds: 691200 },
    ...(legs.length > 1 ? { legs: legs.map((l) => ({ role: "leg", payTo: l.payTo, amount: l.amount })) } : {}),
  };
}

/** A batch-capable memo signer (the cloud's in-process shape) that counts which method was used. */
function batchRecorder() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const counts = { single: 0, batch: 0 };
  return {
    counts,
    address: acct.address,
    signer: {
      address: acct.address,
      async signTypedData(a: Parameters<typeof acct.signTypedData>[0]) {
        counts.single++;
        return acct.signTypedData(a);
      },
      async signTypedDataBatch(list: Parameters<typeof acct.signTypedData>[0][]) {
        counts.batch++;
        return Promise.all(list.map((a) => acct.signTypedData(a)));
      },
    },
  };
}

test("assembleRailPayment: a multi-leg memo 402 is signed in ONE batch and framed as the leg array", async () => {
  const memo = batchRecorder();
  const gw = recorder();
  const payment = await assembleRailPayment(
    memoQuoted([{ payTo: AUTHOR, amount: "600000" }, { payTo: FEE, amount: "300000" }]),
    Date.now(),
    { memo: memo.signer, gateway: gw.signer },
  );
  const payloads = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as Array<{
    authorization: { from: string; to: string; value: string };
    signature: string;
  }>;
  assert.ok(Array.isArray(payloads) && payloads.length === 2, "two legs → the leg array the gate parses");
  assert.equal(payloads[0]!.authorization.to, AUTHOR);
  assert.equal(payloads[0]!.authorization.value, "600000");
  assert.equal(payloads[1]!.authorization.to, FEE);
  assert.equal(payloads[1]!.authorization.value, "300000");
  assert.equal(payloads[0]!.authorization.from, memo.address, "every leg is FROM the injected signer");
  assert.equal(memo.counts.batch, 1, "a batch-capable signer signs the whole toll in ONE call (atomic reserve)");
  assert.equal(memo.counts.single, 0);
  assert.equal(gw.calls.length, 0, "a memo 402 never touches the gateway signer");
});

test("assembleRailPayment: a Gateway 402 routes to the gateway signer and carries the Circle envelope", async () => {
  const memo = batchRecorder();
  const gw = recorder();
  const quoted: Parameters<typeof assembleRailPayment>[0] = {
    priceUsdc: 0,
    amountAtomic: "10000",
    requirements: {
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: AUTHOR,
      amount: "10000",
      maxTimeoutSeconds: 691200,
      ...({ scheme: "exact", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET } } as object),
    },
    resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
  };
  const payment = await assembleRailPayment(quoted, Date.now(), { memo: memo.signer, gateway: gw.signer });
  const envelope = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as { accepted?: { extra?: { name?: string } }; resource?: unknown };
  assert.equal(gw.calls.length, 1, "the gateway signer signs a Gateway 402");
  assert.equal(memo.counts.batch + memo.counts.single, 0);
  assert.equal(envelope.accepted?.extra?.name, "GatewayWalletBatched");
  assert.ok(envelope.resource, "the facilitator's verify rejects an envelope without `resource`");
});

test("assembleRailPayment: a memo 402 with no memo signer throws naming the rail", async () => {
  const gw = recorder();
  await assert.rejects(
    assembleRailPayment(memoQuoted([{ payTo: AUTHOR, amount: "5000" }]), Date.now(), { gateway: gw.signer }),
    /no memo signer/i,
  );
  assert.equal(gw.calls.length, 0);
});
