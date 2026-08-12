import { test } from "node:test";
import assert from "node:assert/strict";
import { createExpressWebhookReceiver } from "./webhook-receiver.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import { signPayload } from "../crypto/webhook.ts";

const SECRET = "whsec_test";

/** A signed delivery, as the sender writes it. */
function signed(over: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify({
    id: "dlv_1",
    type: "settlement.completed",
    eventId: "evt_1",
    createdAt: 1_700_000_000_000,
    data: {},
    ...over,
  });
  const t = Math.floor(Date.now() / 1000);
  return { rawBody, headers: { "naulon-signature": signPayload(SECRET, rawBody, t) } };
}

/** Minimal Express res double — records the status + sent body + headers. */
function fakeRes() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    status(code: number) { r.statusCode = code; return r; },
    setHeader(name: string, value: string) { r.headers[name.toLowerCase()] = value; },
    send(body: string) { r.body = body; },
  };
  return r;
}

/** Minimal Express req double — express.raw() leaves req.body a Buffer. */
function fakeReq(rawBody: string, headers: Record<string, string>) {
  return { params: {}, headers, body: Buffer.from(rawBody, "utf8") };
}

test("valid signed delivery → 200, onEvent runs once, deduped:false", async () => {
  const { rawBody, headers } = signed();
  const seen: string[] = [];
  const handler = createExpressWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async (e) => { seen.push(e.eventId); },
  });
  const res = fakeRes();
  await handler(fakeReq(rawBody, headers) as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, deduped: false });
  assert.equal(seen.length, 1);
});

test("redelivery → 200 deduped:true, onEvent NOT re-run", async () => {
  const { rawBody, headers } = signed();
  const seen: string[] = [];
  const handler = createExpressWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async (e) => { seen.push(e.eventId); },
  });
  await handler(fakeReq(rawBody, headers) as never, fakeRes() as never);
  const res2 = fakeRes();
  await handler(fakeReq(rawBody, headers) as never, res2 as never);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(JSON.parse(res2.body), { ok: true, deduped: true });
  assert.equal(seen.length, 1, "onEvent must not run twice for the same eventId");
});

test("wrong secret → 401, onEvent never runs", async () => {
  const { rawBody, headers } = signed();
  let ran = false;
  const handler = createExpressWebhookReceiver({
    secrets: ["whsec_other"],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => { ran = true; },
  });
  const res = fakeRes();
  await handler(fakeReq(rawBody, headers) as never, res as never);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false);
});

test("req.body is a parsed object (no express.raw) → throws a clear error", async () => {
  const { headers } = signed();
  const handler = createExpressWebhookReceiver({
    secrets: [SECRET],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => {},
  });
  const badReq = { params: {}, headers, body: { eventId: "x" } }; // parsed object, raw bytes lost
  await assert.rejects(
    () => handler(badReq as never, fakeRes() as never),
    /express\.raw/,
    "must fail loud telling the dev to mount express.raw()",
  );
});

test("empty secrets array is rejected at construction", () => {
  assert.throws(
    () => createExpressWebhookReceiver({ secrets: [], idempotency: memoryIdempotencyStore(), onEvent: async () => {} }),
    /at least one secret/,
  );
});
