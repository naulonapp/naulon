/**
 * P2 integration: a REAL paid read through the wired gate (mock settlement) fires a signed
 * `settlement.completed` webhook. This exercises the actual settle path — settle.ts →
 * emitSettlementWebhook → dispatch → sign → send — not a synthetic event, and ties the webhook's
 * eventId back to the minted license's jti (they are the same UUID).
 *
 * Env is set BEFORE importing the app so config binds mock mode + the webhook endpoint; the origin
 * fetch is stubbed; the webhook sender's fetch is stubbed via setWebhookFetchForTest (guardTarget
 * still enforces https on the endpoint url, so no socket is opened but the whole chain runs).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-webhook-settle-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";
process.env.WEBHOOK_SWEEP_INTERVAL_MS = "0"; // sweep driven by hand
process.env.NAULON_WEBHOOK_ENDPOINTS = JSON.stringify([
  { url: "https://hook.internal/naulon", secret: "whsec_integration", events: ["settlement.completed"] },
]);

const { app } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { sweepOnceForTest, setWebhookFetchForTest } = await import("./webhookSink.ts");
const { verifyPayload } = await import("@naulon/shared");

const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const received: { header: string; body: string }[] = [];

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
  setWebhookFetchForTest(async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    received.push({ header: headers["Naulon-Signature"] ?? "", body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  });
});
after(() => {
  globalThis.fetch = realFetch;
  setWebhookFetchForTest(undefined);
  delete process.env.NAULON_WEBHOOK_ENDPOINTS;
});

function decodeJson(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}
function jwtPayload(jws: string): { jti: string; naulon: { slug: string } } {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));
}

test("a real paid read fires a signed settlement.completed whose eventId is the license jti", async () => {
  const first = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(first.status, 402, "unpaid agent gets 402");
  const accepts = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).accepts as Array<{
    amount: string;
    extra: { nonce: string };
  }>)[0]!;
  const sig = buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce);
  const paid = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(paid.status, 200, "paid read succeeds");
  const jws = paid.headers.get("x-naulon-license");
  assert.ok(jws, "paid read mints a license");
  const jti = jwtPayload(jws).jti;

  // Settle enqueued the webhook; drive one sweep to send it through the stubbed sender.
  await sweepOnceForTest();

  assert.equal(received.length, 1, "exactly one settlement.completed delivered");
  const nowSecs = Math.floor(Date.now() / 1000);
  assert.equal(
    verifyPayload("whsec_integration", received[0]!.body, received[0]!.header, nowSecs, 10 * 365 * 86_400),
    true,
    "signature verifies with the endpoint secret",
  );
  const parsed = JSON.parse(received[0]!.body) as {
    type: string;
    eventId: string;
    data: { eventId: string; amountMicro: number; slug: string };
  };
  assert.equal(parsed.type, "settlement.completed");
  assert.equal(parsed.eventId, jti, "webhook eventId === the license jti (same settle event)");
  assert.equal(parsed.data.slug, "on-stillness");
  assert.ok(parsed.data.amountMicro > 0, "carries a positive integer µUSDC amount");
});
