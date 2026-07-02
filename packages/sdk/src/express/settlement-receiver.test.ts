import { test } from "node:test";
import assert from "node:assert/strict";
import { createExpressSettlementReceiver } from "./settlement-receiver.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import { makeSignedSettlementFixture } from "../crypto/fixture.ts";

const SECRET = "shh-test-secret";

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

test("valid signed settlement → 200, onEvent runs once, deduped:false", async () => {
  const { rawBody, headers } = makeSignedSettlementFixture({ secret: SECRET });
  const seen: string[] = [];
  const handler = createExpressSettlementReceiver({
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

test("replay within skew window → 200 deduped:true, onEvent NOT re-run", async () => {
  const { rawBody, headers } = makeSignedSettlementFixture({ secret: SECRET });
  const seen: string[] = [];
  const handler = createExpressSettlementReceiver({
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

test("tampered signature → 401, onEvent never runs", async () => {
  const { rawBody, headers } = makeSignedSettlementFixture({ secret: SECRET });
  let ran = false;
  const handler = createExpressSettlementReceiver({
    secrets: ["a-different-secret"],
    idempotency: memoryIdempotencyStore(),
    onEvent: async () => { ran = true; },
  });
  const res = fakeRes();
  await handler(fakeReq(rawBody, headers) as never, res as never);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false);
});

test("req.body is a parsed object (no express.raw) → throws a clear error", async () => {
  const { headers } = makeSignedSettlementFixture({ secret: SECRET });
  const handler = createExpressSettlementReceiver({
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
    () => createExpressSettlementReceiver({ secrets: [], idempotency: memoryIdempotencyStore(), onEvent: async () => {} }),
    /at least one secret/,
  );
});
