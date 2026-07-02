/**
 * The receiver adapter wraps verifySettlement + the mandatory idempotency gate.
 * These prove the two things a publisher most needs to trust: a VerifyResult maps
 * to the right HTTP status, and a replay inside the skew window is acknowledged
 * but never re-paid (onEvent fires at most once per eventId).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettlementReceiver } from "./settlement-receiver.ts";
import { makeSignedSettlementFixture } from "../crypto/fixture.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import type { SettlementBody } from "../contract/settlement.ts";

const SECRET = "shared-hmac-secret";
const NOW = () => Math.floor(Date.now() / 1000);

function post(fixture: { rawBody: string; headers: Record<string, string> }): Request {
  return new Request("http://pub.test/api/credits/settlement", {
    method: "POST",
    headers: fixture.headers,
    body: fixture.rawBody,
  });
}

test("a valid signed event → 200, onEvent fires once with the parsed body", async () => {
  const seen: SettlementBody[] = [];
  const handler = createSettlementReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async (e) => { seen.push(e); },
  });
  const res = await handler(post(makeSignedSettlementFixture({ secret: SECRET })));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deduped: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.eventId, "11111111-2222-4333-8444-555555555555");
});

test("a replay of the same eventId → 200 deduped, onEvent does NOT fire again", async () => {
  let calls = 0;
  const idem = memoryIdempotencyStore();
  const handler = createSettlementReceiver({
    secrets: [SECRET],
    idempotency: idem,
    onEvent: async () => { calls++; },
  });
  const first = await handler(post(makeSignedSettlementFixture({ secret: SECRET })));
  const second = await handler(post(makeSignedSettlementFixture({ secret: SECRET })));
  assert.deepEqual(await first.json(), { ok: true, deduped: false });
  assert.deepEqual(await second.json(), { ok: true, deduped: true });
  assert.equal(calls, 1, "onEvent fired exactly once across the replay");
});

test("a wrong-secret signature → 401, onEvent never fires", async () => {
  let calls = 0;
  const handler = createSettlementReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => { calls++; },
  });
  const res = await handler(post(makeSignedSettlementFixture({ secret: "attacker" })));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "bad-signature" });
  assert.equal(calls, 0);
});

test("a stale timestamp → 401 stale-timestamp", async () => {
  const handler = createSettlementReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
  });
  const stale = makeSignedSettlementFixture({ secret: SECRET, now: NOW() - 400 });
  const res = await handler(post(stale));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "stale-timestamp" });
});

test("authentic but malformed body (Σ splits ≠ gross) → 400, onEvent never fires", async () => {
  let calls = 0;
  const handler = createSettlementReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => { calls++; },
  });
  const badBody = {
    eventId: "x", slug: "s", txHash: "0x", chainId: 1, currency: "USDC",
    grossAmount: "5000", paidTo: "0x1111111111111111111111111111111111111111",
    payer: null, settledAt: "2023-11-14T22:13:20.000Z",
    splits: [{ authorId: "a", wallet: "0x1111111111111111111111111111111111111111", amount: "4000", weight: 1000, primary: true }],
  } as unknown as SettlementBody;
  const res = await handler(post(makeSignedSettlementFixture({ secret: SECRET, body: badBody })));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid-event" });
  assert.equal(calls, 0);
});

test("rotation: a body signed with the new secret is accepted while old is still listed", async () => {
  const handler = createSettlementReceiver({
    secrets: ["old-secret", "new-secret"],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
  });
  const res = await handler(post(makeSignedSettlementFixture({ secret: "new-secret" })));
  assert.equal(res.status, 200);
});

test("empty secrets array throws at construction (a money receiver must have a secret)", () => {
  assert.throws(
    () => createSettlementReceiver({ secrets: [], idempotency: memoryIdempotencyStore(), onEvent: async () => {} }),
    /at least one secret/,
  );
});
