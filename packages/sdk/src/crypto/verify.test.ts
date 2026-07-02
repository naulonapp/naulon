/**
 * verifySettlement is the verify half of the money-in trust boundary, and the
 * gate's retry behavior keys off its exact status codes (401 transient / 400
 * permanent). These tests pin each {status, reason} so a regression here can't
 * silently change whether the gate retries a delivery.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { signSettlement } from "./sign.ts";
import { verifySettlement } from "./verify.ts";
import { makeSignedSettlementFixture } from "./fixture.ts";
import type { SettlementBody } from "../contract/settlement.ts";

const SECRET = "shared-hmac-secret";
const NOW = 1_700_000_000; // unix seconds

const BODY: SettlementBody = {
  eventId: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  txHash: "0xfeed",
  chainId: 5042002,
  currency: "USDC",
  grossAmount: "5000",
  paidTo: "0x1111111111111111111111111111111111111111" as SettlementBody["paidTo"],
  payer: "0x3333333333333333333333333333333333333333" as SettlementBody["paidTo"],
  settledAt: "2023-11-14T22:13:20.000Z",
  splits: [
    {
      authorId: "mira",
      wallet: "0x1111111111111111111111111111111111111111" as SettlementBody["paidTo"],
      amount: "5000",
      weight: 1000,
      primary: true,
    },
  ],
};

/** Sign a body and return the inputs verifySettlement consumes. */
function signed(body: SettlementBody, secret = SECRET, ts = NOW) {
  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = signSettlement(rawBody, secret, ts);
  return { rawBody, timestampHeader: timestamp, signatureHeader: signature };
}

test("accepts a well-signed, in-window, valid body (round-trip)", () => {
  const r = verifySettlement({ ...signed(BODY), secrets: [SECRET], now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.event.eventId, BODY.eventId);
});

test("rotation: accepts a body signed with any secret in the array", () => {
  const r = verifySettlement({
    ...signed(BODY, "new-secret"),
    secrets: ["old-secret", "new-secret"],
    now: NOW,
  });
  assert.equal(r.ok, true);
});

test("missing timestamp → 401 bad-timestamp", () => {
  const s = signed(BODY);
  const r = verifySettlement({ ...s, timestampHeader: null, secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 401, reason: "bad-timestamp" });
});

test("non-numeric timestamp → 401 bad-timestamp", () => {
  const s = signed(BODY);
  const r = verifySettlement({ ...s, timestampHeader: "not-a-number", secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 401, reason: "bad-timestamp" });
});

test("skew beyond 300s → 401 stale-timestamp", () => {
  const r = verifySettlement({ ...signed(BODY, SECRET, NOW), secrets: [SECRET], now: NOW + 301 });
  assert.deepEqual(r, { ok: false, status: 401, reason: "stale-timestamp" });
});

test("exactly 300s skew is still accepted (boundary)", () => {
  const r = verifySettlement({ ...signed(BODY, SECRET, NOW), secrets: [SECRET], now: NOW + 300 });
  assert.equal(r.ok, true);
});

test("wrong secret → 401 bad-signature", () => {
  const r = verifySettlement({ ...signed(BODY, "attacker"), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 401, reason: "bad-signature" });
});

test("tampered body (signature no longer matches) → 401 bad-signature", () => {
  const s = signed(BODY);
  const tampered = s.rawBody.replace('"5000"', '"9999"');
  const r = verifySettlement({ ...s, rawBody: tampered, secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 401, reason: "bad-signature" });
});

test("missing signature header → 401 bad-signature", () => {
  const s = signed(BODY);
  const r = verifySettlement({ ...s, signatureHeader: null, secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 401, reason: "bad-signature" });
});

test("authentic but non-JSON body → 400 bad-json", () => {
  const rawBody = "not json{";
  const { timestamp, signature } = signSettlement(rawBody, SECRET, NOW);
  const r = verifySettlement({
    rawBody,
    timestampHeader: timestamp,
    signatureHeader: signature,
    secrets: [SECRET],
    now: NOW,
  });
  assert.deepEqual(r, { ok: false, status: 400, reason: "bad-json" });
});

test("Σ splits ≠ grossAmount → 400 invalid-event", () => {
  const bad = { ...BODY, splits: [{ ...BODY.splits[0]!, amount: "4000" }] };
  const r = verifySettlement({ ...signed(bad), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid-event" });
});

test("zero primary splits → 400 invalid-event", () => {
  const split = { ...BODY.splits[0]! };
  delete (split as { primary?: true }).primary;
  const bad = { ...BODY, splits: [split] };
  const r = verifySettlement({ ...signed(bad), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid-event" });
});

test("two primary splits → 400 invalid-event", () => {
  const bad = {
    ...BODY,
    grossAmount: "5000",
    splits: [
      { authorId: "a", wallet: BODY.paidTo, amount: "2500", weight: 500, primary: true as const },
      { authorId: "b", wallet: BODY.paidTo, amount: "2500", weight: 500, primary: true as const },
    ],
  };
  const r = verifySettlement({ ...signed(bad), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid-event" });
});

test("a bad wallet in a split → 400 invalid-event", () => {
  const bad = { ...BODY, splits: [{ ...BODY.splits[0]!, wallet: "0xnope" as SettlementBody["paidTo"] }] };
  const r = verifySettlement({ ...signed(bad), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid-event" });
});

test("an unknown extra field → 400 invalid-event (strict)", () => {
  const bad = { ...BODY, surprise: "x" } as unknown as SettlementBody;
  const r = verifySettlement({ ...signed(bad), secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid-event" });
});

test("empty secrets array throws (programming error, not a 401)", () => {
  assert.throws(
    () => verifySettlement({ ...signed(BODY), secrets: [], now: NOW }),
    /at least one secret/,
  );
});

test("makeSignedSettlementFixture round-trips through verifySettlement", () => {
  const fx = makeSignedSettlementFixture({ secret: SECRET, now: NOW });
  const r = verifySettlement({
    rawBody: fx.rawBody,
    timestampHeader: fx.headers["x-naulon-timestamp"],
    signatureHeader: fx.headers["x-naulon-signature"],
    secrets: [SECRET],
    now: NOW,
  });
  assert.equal(r.ok, true);
});
