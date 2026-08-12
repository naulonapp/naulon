/**
 * The receiver adapter wraps verifyPayload + the mandatory idempotency gate. The
 * cases that matter are the money-shaped ones: a redelivery must not run the
 * handler twice, and a handler that FAILS must not have its event swallowed by the
 * dedupe on the next attempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookReceiver } from "./webhook-receiver.ts";
import { signPayload } from "../crypto/webhook.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import type { WebhookEnvelope } from "../contract/webhook.ts";

const SECRET = "whsec_test";
const NOW = 1_700_000_000;

function envelope(over: Partial<WebhookEnvelope> = {}): WebhookEnvelope {
  return {
    id: "dlv_1",
    type: "settlement.completed",
    eventId: "evt_1",
    createdAt: NOW * 1000,
    data: { tenant: "acme", announced: 2 },
    ...over,
  };
}

/** A request signed the way the sender signs it. */
function post(body: unknown, opts: { secret?: string; at?: number } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const at = opts.at ?? NOW;
  return new Request("http://pub.test/naulon-hook", {
    method: "POST",
    headers: { "naulon-signature": signPayload(opts.secret ?? SECRET, raw, at) },
    body: raw,
  });
}

test("an authentic delivery runs the handler once and answers 200", async () => {
  const seen: WebhookEnvelope[] = [];
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async (e) => void seen.push(e),
    now: () => NOW,
  });
  const res = await handler(post(envelope()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deduped: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.eventId, "evt_1");
});

test("a redelivery of the same eventId is acknowledged but not re-run", async () => {
  let runs = 0;
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => void runs++,
    now: () => NOW,
  });
  await handler(post(envelope()));
  // A retry carries a NEW delivery id but the same source eventId — dedupe on eventId.
  const second = await handler(post(envelope({ id: "dlv_2" })));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, deduped: true });
  assert.equal(runs, 1);
});

test("a handler that throws releases its claim, so the retry is processed", async () => {
  let attempts = 0;
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {
      attempts++;
      if (attempts === 1) throw new Error("db down");
    },
    now: () => NOW,
  });
  await assert.rejects(() => handler(post(envelope())), /db down/);
  const retry = await handler(post(envelope({ id: "dlv_2" })));
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ok: true, deduped: false });
  assert.equal(attempts, 2, "the retry must not be deduped into silence");
});

test("a wrong secret is 401 and never reaches the handler", async () => {
  let runs = 0;
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => void runs++,
    now: () => NOW,
  });
  const res = await handler(post(envelope(), { secret: "attacker" }));
  assert.equal(res.status, 401);
  assert.equal(runs, 0);
});

test("a missing signature header is 401", async () => {
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
    now: () => NOW,
  });
  const res = await handler(
    new Request("http://pub.test/naulon-hook", { method: "POST", body: "{}" }),
  );
  assert.equal(res.status, 401);
});

test("a stale timestamp is 401 (replay window), a fresh one inside it is 200", async () => {
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
    now: () => NOW,
  });
  assert.equal((await handler(post(envelope(), { at: NOW - 301 }))).status, 401);
  assert.equal((await handler(post(envelope(), { at: NOW - 299 }))).status, 200);
});

test("rotation: either secret in the array verifies", async () => {
  const handler = createWebhookReceiver({
    secrets: ["whsec_new", "whsec_old"],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
    now: () => NOW,
  });
  assert.equal((await handler(post(envelope(), { secret: "whsec_old" }))).status, 200);
  assert.equal(
    (await handler(post(envelope({ eventId: "evt_2" }), { secret: "whsec_new" }))).status,
    200,
  );
});

test("an authentic body that is not JSON is 400, not 401", async () => {
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
    now: () => NOW,
  });
  const res = await handler(post("not json"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad-json" });
});

test("an authentic body missing eventId is 400 — there would be nothing to dedupe on", async () => {
  const handler = createWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
    now: () => NOW,
  });
  const res = await handler(post({ id: "d", type: "ping", createdAt: 0, data: {} }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid-envelope" });
});

test("no secrets is a construction-time throw, not a silent accept-everything", () => {
  assert.throws(
    () =>
      createWebhookReceiver({
        secrets: [],
        idempotency: memoryIdempotencyStore(),
        onEvent: async () => {},
      }),
    /at least one secret/,
  );
});
