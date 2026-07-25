import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPayload } from "@naulon/webhooks";
import {
  emitSettlementWebhook,
  startWebhookSweep,
  sweepOnceForTest,
  resetWebhookSinkForTest,
  setWebhookFetchForTest,
} from "./webhookSink.ts";
import { usdc, walletAddress, resetConfig, type AttributedEvent } from "@naulon/shared";

function fakeEvent(): AttributedEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    publisherId: "default",
    slug: "essays/x",
    kind: "read",
    amount: usdc(0.001),
    payees: [{ wallet: walletAddress("0x" + "1".repeat(40)), shareBps: 10_000 }],
    payerAddress: walletAddress("0x" + "2".repeat(40)),
    settlementRef: "0xdeadbeef",
    chainId: 1,
    at: 1_700_000_000_000,
  };
}

test("dark by default: no env endpoints ⇒ emit is a no-op that never throws", async () => {
  setWebhookFetchForTest(undefined);
  resetWebhookSinkForTest();
  delete process.env["NAULON_WEBHOOK_ENDPOINTS"];
  resetConfig();
  await emitSettlementWebhook(fakeEvent(), "site.test"); // must not throw / must not open anything
  const { stop } = startWebhookSweep();
  stop();
  assert.ok(true);
});

test("configured endpoint receives a signed settlement.completed that verifyPayload accepts", async () => {
  const received: { header: string; body: string }[] = [];
  // Stub the sender's fetch: guardTarget still enforces https (below), but no TLS/socket is opened.
  setWebhookFetchForTest(async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    received.push({ header: headers["Naulon-Signature"] ?? "", body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  });
  process.env["NAULON_WEBHOOK_ENDPOINTS"] = JSON.stringify([
    { url: "https://hook.internal/naulon", secret: "whsec_test", events: ["settlement.completed"] },
  ]);
  process.env["WEBHOOK_SWEEP_INTERVAL_MS"] = "0"; // we drive the sweep by hand
  resetConfig();

  await emitSettlementWebhook(fakeEvent(), "site.test");
  await sweepOnceForTest();

  assert.equal(received.length, 1);
  // signPayload signs with the SEND time (Date.now during the sweep); verifyPayload recomputes the
  // HMAC from the t parsed out of the header, so nowSecs only gates the replay window — a wide
  // tolerance keeps this deterministic regardless of wall-clock.
  const nowSecs = Math.floor(Date.now() / 1000);
  assert.equal(
    verifyPayload("whsec_test", received[0]!.body, received[0]!.header, nowSecs, 10 * 365 * 86_400),
    true,
  );
  // The raw wire is the canonical envelope { id, type, eventId, createdAt, data }; our body is data.
  const parsed = JSON.parse(received[0]!.body) as {
    type: string;
    eventId: string;
    data: { amountMicro: number; settlementRef: string; publisherId: string };
  };
  assert.equal(parsed.type, "settlement.completed");
  assert.equal(parsed.eventId, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.data.amountMicro, 1000); // 0.001 USDC → 1000 µUSDC (integer)
  assert.equal(parsed.data.settlementRef, "0xdeadbeef");

  setWebhookFetchForTest(undefined);
  delete process.env["NAULON_WEBHOOK_ENDPOINTS"];
  resetConfig();
});
