import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { usdc, walletAddress } from "@naulon/shared";
import type { Quote } from "@naulon/enforce";
import {
  build402,
  buildGatewaySignature,
  buildGatewaySignatures,
  buildMockSignature,
  drainPendingLegs,
  type PaymentRequirements,
  verifyAndSettle,
} from "./x402.ts";
import { getPendingLegSink, resetPendingLegSink } from "./pendingLegs.ts";

// Standard anvil/hardhat account #0 — deterministic, public, never funded.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// A Gateway batching requirements, the shape build402 emits in gateway mode.
function gatewayRequirements(maxTimeoutSeconds = 691_200): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532", // Base Sepolia
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "1000",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x2222222d7164433c4c09b0b0d809a9b52c04c205",
    },
  };
}

// Default config is PAYMENT_MODE=mock, so verifyAndSettle runs the offline path.
const quote: Quote = {
  slug: "on-stillness",
  title: "On Stillness",
  kind: "read",
  price: usdc(0.001),
  payees: [
    { authorId: "ava", wallet: walletAddress("0x1111111111111111111111111111111111111111"), share: 1 },
  ],
  extraLegs: [],
  coauthorSplit: false,
};

function issue(now: number) {
  const { requirements, header } = build402(quote, "http://gate/essays/on-stillness", now);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { extra: { nonce: string } }[];
  };
  return { requirements, nonce: decoded.accepts[0]!.extra.nonce };
}

test("a valid signed payment with a fresh nonce settles", async () => {
  const now = 1_000_000;
  const { requirements, nonce } = issue(now);
  const sig = buildMockSignature("0x2222222222222222222222222222222222222222", requirements.amount, nonce);
  const result = await verifyAndSettle(sig, requirements, now);
  assert.equal(result.ok, true);
});

test("replaying the same payment-signature is rejected", async () => {
  const now = 1_000_000;
  const { requirements, nonce } = issue(now);
  const sig = buildMockSignature("0x2222222222222222222222222222222222222222", requirements.amount, nonce);
  assert.equal((await verifyAndSettle(sig, requirements, now)).ok, true);
  const replay = await verifyAndSettle(sig, requirements, now);
  assert.equal(replay.ok, false);
  assert.match(replay.error!, /replay/);
});

test("a payment with no nonce is rejected in mock mode", async () => {
  const now = 1_000_000;
  const { requirements } = issue(now);
  const sig = buildMockSignature("0x2222222222222222222222222222222222222222", requirements.amount);
  const result = await verifyAndSettle(sig, requirements, now);
  assert.equal(result.ok, false);
  assert.match(result.error!, /nonce/);
});

test("an underpayment is rejected", async () => {
  const now = 1_000_000;
  const { requirements, nonce } = issue(now);
  const sig = buildMockSignature("0x2222222222222222222222222222222222222222", "1", nonce);
  const result = await verifyAndSettle(sig, requirements, now);
  assert.equal(result.ok, false);
  assert.match(result.error!, /insufficient/);
});

// ── N-leg (operator fee): the naulonLegs 402 extension + per-leg verify/settle ──
const PAYER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";

const multiLegQuote: Quote = {
  ...quote,
  extraLegs: [{ role: "operator", payTo: walletAddress(OPERATOR), amount: "500" }],
};

type WireLeg = { role: string; payTo: string; amount: string; nonce: string };

// Build a 402 for the multi-leg quote and return the gate's authoritative leg
// requirements + the wire legs a buyer reads from naulonLegs.
function issueMulti(now: number) {
  const { legs, header } = build402(multiLegQuote, "http://gate/essays/on-stillness", now);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    extensions?: { naulonLegs?: { legs: WireLeg[] } };
  };
  return { legReqs: legs.map((l) => l.requirements), wireLegs: decoded.extensions?.naulonLegs?.legs ?? [], decoded };
}

// A multi-leg mock payment-signature: one { payer, amount, nonce } per wire leg.
function mockMultiSig(wireLegs: WireLeg[], amounts?: string[]): string {
  const payloads = wireLegs.map((l, i) => ({ payer: PAYER, amount: amounts?.[i] ?? l.amount, nonce: l.nonce }));
  return Buffer.from(JSON.stringify(payloads)).toString("base64");
}

test("build402 omits the naulonLegs extension for a plain single-author quote (byte-identical 402)", () => {
  const { header } = build402(quote, "http://gate/essays/on-stillness", 1_000_000);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal((decoded.accepts as unknown[]).length, 1);
  assert.equal("extensions" in decoded, false);
});

test("build402 advertises naulonLegs (author + extra) but leaves accepts[0] the stock primary leg", () => {
  const { decoded, wireLegs } = issueMulti(1_000_000);
  assert.equal((decoded as { accepts: unknown[] }).accepts.length, 1); // non-naulon clients degrade to single-leg
  const naulon = (decoded as { extensions: { naulonLegs: { version: number; settlement: string; legs: WireLeg[] } } }).extensions.naulonLegs;
  assert.equal(naulon.version, 1);
  assert.equal(naulon.settlement, "author-sync-rest-deferred");
  assert.equal(naulon.legs.length, 2);
  assert.equal(naulon.legs[0]!.role, "author");
  assert.equal(naulon.legs[1]!.role, "operator");
  assert.equal(naulon.legs[1]!.payTo.toLowerCase(), OPERATOR);
  assert.equal(naulon.legs[1]!.amount, "500");
  assert.notEqual(wireLegs[0]!.nonce, wireLegs[1]!.nonce); // each leg has its own replay nonce
});

test("a multi-leg payment settles the author synchronously and DEFERS the extra leg (O5)", async () => {
  resetPendingLegSink();
  const now = 1_000_000;
  const { legReqs, wireLegs } = issueMulti(now);
  const result = await verifyAndSettle(mockMultiSig(wireLegs), legReqs, now);
  assert.equal(result.ok, true);
  assert.equal(result.legSettlements!.length, 2);
  // Author leg: settled synchronously, drives the response/settlementRef.
  assert.equal(result.legSettlements![0]!.settled, true);
  assert.equal(result.legSettlements![0]!.payTo.toLowerCase(), "0x1111111111111111111111111111111111111111");
  assert.match(result.settlementRef!, /^mock-/);
  // Extra leg: buyer-authorized but NOT settled at the gate — deferred to the drain.
  assert.equal(result.legSettlements![1]!.settled, false);
  assert.equal(result.legSettlements![1]!.settlementRef, undefined);
  assert.equal(result.legSettlements![1]!.payTo.toLowerCase(), OPERATOR);
  assert.equal(result.legSettlements![1]!.amount, "500");
});

test("drainPendingLegs settles the deferred extra leg, idempotently (O1/O5)", async () => {
  resetPendingLegSink();
  const now = 1_000_000;
  const { legReqs, wireLegs } = issueMulti(now);
  const result = await verifyAndSettle(mockMultiSig(wireLegs), legReqs, now, "pub-x");
  assert.equal(result.ok, true);
  assert.equal(result.legSettlements![1]!.settled, false, "deferred at the gate");

  // Exactly one leg is queued for this publisher (scoped).
  const sink = getPendingLegSink();
  assert.equal((await sink.pending(now, "pub-x")).length, 1);
  assert.equal((await sink.pending(now, "other-pub")).length, 0, "scoped: another publisher sees none");

  // The drain settles it on-chain (mock: consumes its nonce).
  assert.deepEqual(await drainPendingLegs({ publisherId: "pub-x" }, now), { settled: 1, failed: 0 });
  assert.equal((await sink.pending(now, "pub-x")).length, 0, "no longer pending");

  // Idempotent: a second pass settles nothing — the leg is marked + the nonce is spent.
  assert.deepEqual(await drainPendingLegs({ publisherId: "pub-x" }, now), { settled: 0, failed: 0 });
});

test("drainPendingLegs skips an expired authorization (never charges the buyer late)", async () => {
  resetPendingLegSink();
  const now = 1_000_000;
  const { legReqs, wireLegs } = issueMulti(now);
  await verifyAndSettle(mockMultiSig(wireLegs), legReqs, now, "pub-exp");
  // Drain far past the mock validity window (now + 8d advertised) → the leg has expired
  // and is not attempted; the buyer is never charged for a dead authorization.
  const wayLater = now + 9 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await drainPendingLegs({ publisherId: "pub-exp" }, wayLater), { settled: 0, failed: 0 });
});

test("a payment with the wrong number of legs is rejected", async () => {
  const now = 1_000_000;
  const { legReqs, wireLegs } = issueMulti(now);
  // Send only the author leg's payload for a two-leg quote.
  const oneLeg = Buffer.from(JSON.stringify([{ payer: PAYER, amount: wireLegs[0]!.amount, nonce: wireLegs[0]!.nonce }])).toString("base64");
  const result = await verifyAndSettle(oneLeg, legReqs, now);
  assert.equal(result.ok, false);
  assert.match(result.error!, /mismatch/);
});

test("an underpaid extra leg rejects the whole payment without spending the author nonce (verify-all-first)", async () => {
  const now = 1_000_000;
  const { legReqs, wireLegs } = issueMulti(now);
  // Underpay only the operator leg (index 1).
  const bad = await verifyAndSettle(mockMultiSig(wireLegs, [wireLegs[0]!.amount, "1"]), legReqs, now);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /leg 1/);
  // The author nonce must NOT have been consumed by the rejected attempt: a corrected
  // retry with the SAME nonces settles. This is the atomicity guarantee.
  const good = await verifyAndSettle(mockMultiSig(wireLegs), legReqs, now);
  assert.equal(good.ok, true);
});

test("a single-leg (bare object) signature still settles a single-author quote — back-compat", async () => {
  const now = 1_000_000;
  const { requirements, nonce } = issue(now);
  // Today's shape: a bare object, not an array.
  const sig = buildMockSignature(PAYER, requirements.amount, nonce);
  const result = await verifyAndSettle(sig, requirements, now);
  assert.equal(result.ok, true);
  assert.equal(result.legSettlements!.length, 1);
});

// ── Co-author on-chain splits (PR2): split-at-source, custody-free ──
const COAUTHOR = "0x4444444444444444444444444444444444444444";

// Two equal authors; base price 0.001 USDC = 1000 micro → 500 each.
const coauthorQuote: Quote = {
  ...quote,
  payees: [
    { authorId: "ava", wallet: walletAddress("0x1111111111111111111111111111111111111111"), share: 0.5 },
    { authorId: "co", wallet: walletAddress(COAUTHOR), share: 0.5 },
  ],
  coauthorSplit: true,
};

function decodeNaulonLegs(header: string): WireLeg[] | undefined {
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    extensions?: { naulonLegs?: { legs: WireLeg[] } };
  };
  return decoded.extensions?.naulonLegs?.legs;
}

test("build402 with coauthorSplit DIVIDES the price into the primary + a co-author leg (Σ == price)", () => {
  const { legs, header } = build402(coauthorQuote, "http://gate/essays/on-stillness", 1_000_000);
  const wire = decodeNaulonLegs(header)!;
  assert.equal(wire.length, 2);
  assert.equal(wire[0]!.role, "author");
  assert.equal(wire[0]!.amount, "500"); // primary's HALF — not the full 1000
  assert.equal(wire[1]!.role, "coauthor");
  assert.equal(wire[1]!.payTo.toLowerCase(), COAUTHOR);
  assert.equal(wire[1]!.amount, "500");
  // The buyer's total is unchanged: the price is divided, not added to.
  const sum = legs.reduce((s, l) => s + Number(l.requirements.amount), 0);
  assert.equal(sum, 1000);
});

test("a co-author split settles the primary synchronously and DEFERS the co-author leg (custody-free)", async () => {
  resetPendingLegSink();
  const now = 1_000_000;
  const { legs, header } = build402(coauthorQuote, "http://gate/essays/on-stillness", now);
  const wire = decodeNaulonLegs(header)!;
  const result = await verifyAndSettle(mockMultiSig(wire), legs.map((l) => l.requirements), now, "pub-co");
  assert.equal(result.ok, true);
  assert.equal(result.legSettlements!.length, 2);
  // Primary: settled at the gate, gates content.
  assert.equal(result.legSettlements![0]!.settled, true);
  assert.equal(result.legSettlements![0]!.amount, "500");
  assert.equal(result.legSettlements![0]!.payTo.toLowerCase(), "0x1111111111111111111111111111111111111111");
  // Co-author: a DIRECT buyer→co-author transfer, deferred to the drain (never the lead's to hold).
  assert.equal(result.legSettlements![1]!.settled, false);
  assert.equal(result.legSettlements![1]!.payTo.toLowerCase(), COAUTHOR);
  assert.equal(result.legSettlements![1]!.amount, "500");
  // The drain settles the co-author leg on-chain (mock: consumes its nonce).
  assert.deepEqual(await drainPendingLegs({ publisherId: "pub-co" }, now), { settled: 1, failed: 0 });
});

test("coauthorSplit OFF with co-authors → stock single-recipient toll (no naulonLegs, primary gets full price)", () => {
  const offQuote: Quote = { ...coauthorQuote, coauthorSplit: false };
  const { legs, header } = build402(offQuote, "http://gate/essays/on-stillness", 1_000_000);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal("extensions" in decoded, false); // byte-identical to the stock 402
  assert.equal(legs.length, 1);
  assert.equal(legs[0]!.requirements.amount, "1000"); // full price to the primary
});

// ── Gateway buyer: the real EIP-712-signed signature (offline shape check) ──
// The facilitator's `verify` rejects a mock-shaped signature 400
// (`x402Version/resource/accepted/payload: Required`). These prove our gateway
// buyer emits the exact shape it requires, without touching the network.

test("buildGatewaySignature emits the exact { x402Version, payload, resource, accepted } verify requires", async () => {
  const requirements = gatewayRequirements();
  const resource = { url: "http://gate/essays/x", description: "toll", mimeType: "text/html" };
  const header = await buildGatewaySignature(TEST_PK, requirements, resource);
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    x402Version: number;
    resource: unknown;
    accepted: unknown;
    payload: { authorization: { from: string; value: string }; signature: string };
  };

  // The four top-level fields the 400 named as Required.
  for (const k of ["x402Version", "payload", "resource", "accepted"] as const) {
    assert.ok(k in decoded, `missing required field ${k}`);
  }
  assert.equal(decoded.x402Version, 2);
  assert.deepEqual(decoded.accepted, requirements);
  assert.deepEqual(decoded.resource, resource);

  const { authorization, signature } = decoded.payload;
  assert.match(signature, /^0x[0-9a-fA-F]{130}$/); // 65-byte ECDSA signature
  assert.equal(authorization.from.toLowerCase(), privateKeyToAccount(TEST_PK).address.toLowerCase());
  assert.equal(authorization.value, requirements.amount);
});

test("buildGatewaySignatures signs one authorization per leg into the array verifyAndSettle parses", async () => {
  const author = gatewayRequirements();
  const operator = { ...author, payTo: "0x3333333333333333333333333333333333333333", amount: "500", extra: { ...author.extra } };
  const sig = await buildGatewaySignatures(TEST_PK, [author, operator], { url: "http://gate/x" });
  const arr = JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as {
    payload: { authorization: { to: string; value: string } };
    accepted: { payTo: string };
  }[];
  assert.equal(arr.length, 2);
  // Each leg is its own signed authorization to its own recipient/amount.
  assert.equal(arr[0]!.payload.authorization.value, author.amount);
  assert.equal(arr[1]!.payload.authorization.to.toLowerCase(), operator.payTo);
  assert.equal(arr[1]!.payload.authorization.value, "500");
  assert.equal(arr[1]!.accepted.payTo, operator.payTo);
});

test("buildGatewaySignature clamps a sub-floor advertised window up to Circle's 604900 minimum", async () => {
  // Even if the gate advertised a too-short window, the SDK buyer signs above the
  // 7-day floor — the "SDK buyers survive a low value" half of the footgun story.
  const header = await buildGatewaySignature(TEST_PK, gatewayRequirements(100), {});
  const { authorization } = JSON.parse(Buffer.from(header, "base64").toString("utf8")).payload as {
    authorization: { validAfter: string; validBefore: string };
  };
  assert.ok(Number(authorization.validBefore) - Number(authorization.validAfter) >= 604_900);
});
