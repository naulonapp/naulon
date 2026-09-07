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
  // The 402 the real gate builds always carries the Gateway descriptor (build402 stamps it on
  // every gateway-mode challenge). This test is about the payee guard, not the rail, so it uses
  // that real shape rather than the memo-only fixture it happened to use while Arc self-relayed.
  const restore = stubFetch(memo402WithGatewayExtra());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read", {
      maxTotalAtomic: "1000000",
      authorizePayee: (payTo) => payTo === AUTHOR,
    });
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(gw.calls.length >= 1, "an authorized payee signs normally");
    assert.equal(memo.calls.length, 0, "settlement is Gateway on every chain now");
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

test("a 402 on a known chain with no Gateway descriptor is REFUSED, not signed as memo", async () => {
  // Before 2026-09-04 this selected the memo builder, because Arc self-relayed. Now the gate
  // settles every chain through Circle, so a challenge missing the Gateway descriptor does not
  // match anything the gate can settle — and signing a raw EIP-3009 for it would produce a payment
  // the facilitator rejects. Refusing here, by name, is the correct outcome.
  const memo = recorder();
  const gw = recorder();
  const restore = stubFetch(memo402());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, false, "a non-gateway 402 cannot be paid");
    assert.equal(memo.calls.length, 0, "the memo signer must never be selected for a toll");
    assert.match(
      String((result as { error?: string }).error ?? ""),
      /GatewayWalletBatched/,
      "the refusal must name the descriptor that was missing",
    );
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

test("a memo-CAPABLE chain signs the Gateway envelope — the predeploy is not a rail instruction", async () => {
  // The exact inverse of what this test asserted before, and the reason it is kept rather than
  // deleted: arcTestnet still carries `memo` in the registry (a withdrawal may yet want to tag a
  // transaction with it), so the tempting reading is that a memo-capable chain signs memo-style.
  // It does not. The gate settles Arc through Circle, and buyer and gate must agree or the settle
  // fails as "malformed memo payload".
  const memo = recorder();
  const gw = recorder();
  assert.equal(supportsMemo(activeNetwork()), true, "precondition: the fleet default still ships a Memo predeploy");
  const restore = stubFetch(memo402WithGatewayExtra());
  try {
    const result = await railBuyer({ memo: memo.signer, gateway: gw.signer }).fetch("https://x.test/a", "read");
    assert.equal(result.ok, true, `expected a paid read, got ${JSON.stringify(result)}`);
    assert.ok(gw.calls.length >= 1, "the gateway signer must be consulted on a memo-capable chain");
    assert.equal(memo.calls.length, 0, "the memo signer must NOT be consulted for a toll");
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

/** The shape the real gate advertises: every leg carries the Circle descriptor `build402` stamps,
 *  and `legs` is present only for a multi-leg toll (author + operator fee, or co-author splits). */
function gatewayQuoted(legs: { payTo: string; amount: string }[]): Parameters<typeof assembleRailPayment>[0] {
  const net = activeNetwork();
  const first = legs[0]!;
  const extra = { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET };
  return {
    priceUsdc: 0,
    amountAtomic: first.amount,
    requirements: {
      network: net.network,
      asset: net.usdc,
      payTo: first.payTo,
      amount: first.amount,
      maxTimeoutSeconds: 691200,
      ...({ scheme: "exact", extra } as object),
    },
    resource: { url: "https://x.test/a", description: "naulon read toll: A", mimeType: "text/html" },
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

test("assembleRailPayment: a multi-leg Gateway 402 signs ONE ENVELOPE PER LEG, in leg order", async () => {
  // The operator fee is a second buyer→operator leg, and custody-free requires it to stay that way
  // rather than becoming a skim from the author's cut. Circle's SDK signs one leg per call, so a
  // two-leg toll used to be memo-rail-only — which made the fee collectable on exactly one chain.
  // The rail was never the limit: the gate parses an array of per-leg payloads and verifies each
  // leg against its own requirements, so N legs settle on Gateway once the buyer signs N envelopes.
  const memo = batchRecorder();
  const gw = recorder();
  const payment = await assembleRailPayment(
    gatewayQuoted([{ payTo: AUTHOR, amount: "600000" }, { payTo: FEE, amount: "300000" }]),
    Date.now(),
    { memo: memo.signer, gateway: gw.signer },
  );
  const envelopes = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as Array<{
    accepted?: { payTo?: string; amount?: string; extra?: { name?: string } };
  }>;
  assert.ok(Array.isArray(envelopes), "multi-leg frames as the ARRAY the gate parses");
  assert.equal(envelopes.length, 2, "one envelope per advertised leg");
  assert.equal(gw.calls.length, 2, "the gateway signer is called once per leg");
  assert.equal(memo.counts.batch + memo.counts.single, 0, "the memo signer is never involved");
  // Leg ORDER is the contract — the gate pairs payloads[i] with its own legs[i].
  assert.equal(envelopes[0]!.accepted?.payTo, AUTHOR, "leg 0 is the author");
  assert.equal(envelopes[0]!.accepted?.amount, "600000");
  assert.equal(envelopes[1]!.accepted?.payTo, FEE, "leg 1 is the operator fee");
  assert.equal(envelopes[1]!.accepted?.amount, "300000");
  for (const e of envelopes) {
    assert.equal(e.accepted?.extra?.name, "GatewayWalletBatched", "every leg carries the Circle descriptor");
  }
});

test("assembleRailPayment: a single-leg Gateway 402 stays a bare envelope, not a one-element array", async () => {
  // Stock x402 clients send the bare object and the gate accepts either shape, so the common case
  // must not change on the wire just because the multi-leg path grew an array.
  const gw = recorder();
  const payment = await assembleRailPayment(gatewayQuoted([{ payTo: AUTHOR, amount: "5000" }]), Date.now(), {
    gateway: gw.signer,
  });
  const parsed = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as unknown;
  assert.equal(Array.isArray(parsed), false, "one leg → the bare envelope");
  assert.equal(gw.calls.length, 1);
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

test("assembleRailPayment: a single-leg 402 with no Gateway descriptor throws naming the descriptor", async () => {
  // Was "no memo signer": before 2026-09-04 a known memo chain routed to the memo signer, so an
  // absent one was the first thing to fail. Every chain routes to Gateway now, so the first guard
  // reached is the descriptor check — and a memo signer being present or absent is irrelevant.
  const gw = recorder();
  await assert.rejects(
    assembleRailPayment(memoQuoted([{ payTo: AUTHOR, amount: "5000" }]), Date.now(), { gateway: gw.signer }),
    /GatewayWalletBatched/,
  );
  assert.equal(gw.calls.length, 0, "the signer is never reached — nothing is spent on a malformed 402");
});
