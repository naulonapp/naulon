import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatchEvent, sweepWebhookDeliveries, BACKOFF_OFFSETS_MS } from "./dispatch.ts";
import { MemoryWebhookEndpointStore, MemoryWebhookDeliveryStore } from "./memory-store.ts";
import type { WebhookSender, SendResult } from "./sender.ts";
import type { NewWebhookEndpoint, WebhookEvent } from "./types.ts";

function fakeSender(send: () => Promise<SendResult>): WebhookSender {
  return { kind: "fake", send };
}
const okSender = fakeSender(async () => ({ ok: true, statusCode: 200, body: "ok" }));
const failSender = fakeSender(async () => ({ ok: false, statusCode: 500, body: "no", error: "500" }));
const blockedSender = fakeSender(async () => ({ ok: false, blocked: true, error: "blocked" }));

function epInput(over: Partial<NewWebhookEndpoint> = {}): NewWebhookEndpoint {
  return {
    ownerUserId: "o1",
    channelType: "raw",
    hostFilter: null,
    url: "https://x.test/hook",
    secret: "whsec_a",
    eventTypes: ["anomaly.detected"],
    description: null,
    createdBy: "u1",
    ...over,
  };
}
const EV: WebhookEvent = { ownerUserId: "o1", host: null, type: "anomaly.detected", eventId: "e1", payload: { a: 1 } };

function makeStores() {
  return { endpoints: new MemoryWebhookEndpointStore(() => 1000), deliveries: new MemoryWebhookDeliveryStore(() => 1000) };
}

test("payloadFor renders each endpoint's profile at enqueue (per-endpoint body); dedup key unchanged", async () => {
  const { endpoints, deliveries } = makeStores();
  const summaryEp = await endpoints.create(epInput({ payloadProfile: "summary", eventTypes: ["settlement.completed"] }));
  const detailedEp = await endpoints.create(epInput({ payloadProfile: "detailed", eventTypes: ["settlement.completed"] }));
  const ev: WebhookEvent = {
    ownerUserId: "o1", host: null, type: "settlement.completed", eventId: "settle:1",
    payload: { fallback: true },
    payloadFor: (profile) => (profile === "detailed" ? { rich: true, gross: 8800 } : { lean: true }),
  };
  await makeDispatchEvent({ endpoints, deliveries, sender: okSender, autoDisableThreshold: 20, concurrency: 5 })(ev);

  const sRows = await deliveries.listForEndpoint(summaryEp.id, null, 10);
  const dRows = await deliveries.listForEndpoint(detailedEp.id, null, 10);
  assert.deepEqual(sRows[0]!.payload, { lean: true });   // summary endpoint → lean body
  assert.deepEqual(dRows[0]!.payload, { rich: true, gross: 8800 }); // detailed endpoint → rich body
  assert.equal(sRows[0]!.eventId, "settle:1"); // same dedup key regardless of profile
  assert.equal(dRows[0]!.eventId, "settle:1");
});

test("no payloadFor ⇒ every endpoint gets the plain payload (anomaly path unchanged)", async () => {
  const { endpoints, deliveries } = makeStores();
  const ep = await endpoints.create(epInput({ payloadProfile: "detailed" }));
  await makeDispatchEvent({ endpoints, deliveries, sender: okSender, autoDisableThreshold: 20, concurrency: 5 })(EV);
  const rows = await deliveries.listForEndpoint(ep.id, null, 10);
  assert.deepEqual(rows[0]!.payload, { a: 1 }); // EV.payload verbatim — profile irrelevant without payloadFor
});

test("dispatch ENQUEUES one pending row per deliverable endpoint and does NOT send", async () => {
  const { endpoints, deliveries } = makeStores();
  await endpoints.create(epInput());
  let sent = 0;
  const spy = fakeSender(async () => {
    sent++;
    return { ok: true };
  });
  await makeDispatchEvent({ endpoints, deliveries, sender: spy, autoDisableThreshold: 20, concurrency: 5 })(EV);
  assert.equal(sent, 0); // no HTTP in dispatch
  const id = (await endpoints.listForOwner("o1"))[0]!.id;
  const all = await deliveries.listForEndpoint(id, null, 10);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.status, "pending");
  assert.equal(all[0]!.attemptCount, 0);
});

test("dispatch is idempotent: same eventId twice ⇒ one row (dedup)", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  const d = makeDispatchEvent({ endpoints, deliveries, sender: okSender, autoDisableThreshold: 20, concurrency: 5 });
  await d(EV);
  await d(EV);
  assert.equal((await deliveries.listForEndpoint(e.id, null, 10)).length, 1);
});

test("host_filter scopes enqueue to the matching site", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput({ hostFilter: "a.test" }));
  await makeDispatchEvent({ endpoints, deliveries, sender: okSender, autoDisableThreshold: 20, concurrency: 5 })({
    ...EV,
    host: "b.test",
  });
  assert.equal((await deliveries.listForEndpoint(e.id, null, 10)).length, 0);
});

test("a flag-OFF channel is skipped at enqueue", async () => {
  const { endpoints, deliveries } = makeStores();
  await endpoints.create(epInput({ channelType: "slack", secret: null, url: "https://hooks.slack.com/x" }));
  await makeDispatchEvent({
    endpoints,
    deliveries,
    sender: okSender,
    autoDisableThreshold: 20,
    concurrency: 5,
    isChannelEnabled: async (ct) => ct !== "slack",
  })(EV);
  assert.equal((await deliveries.listDue(2000, 10)).length, 0);
});

test("sweep: first pickup attempts; a 500 schedules next by backoff", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  const deps = { endpoints, deliveries, sender: failSender, autoDisableThreshold: 20, concurrency: 5, now: () => 1000 };
  await makeDispatchEvent(deps)(EV);
  const summary = await sweepWebhookDeliveries(deps, 2000);
  assert.equal(summary.attempted, 1);
  const d = (await deliveries.listForEndpoint(e.id, null, 10))[0]!;
  assert.equal(d.status, "pending");
  assert.equal(d.attemptCount, 1);
  assert.equal(d.nextAttemptAt, 2000 + BACKOFF_OFFSETS_MS[0]!);
});

test("sweep: a 2xx delivers and resets endpoint failures", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  await endpoints.bumpFailures(e.id);
  const deps = { endpoints, deliveries, sender: okSender, autoDisableThreshold: 20, concurrency: 5, now: () => 1000 };
  await makeDispatchEvent(deps)(EV);
  await sweepWebhookDeliveries(deps, 2000);
  assert.equal((await deliveries.listForEndpoint(e.id, null, 10))[0]!.status, "delivered");
  assert.equal((await endpoints.get(e.id))!.consecutiveFailures, 0);
});

test("sweep exhausts a delivery after 8 attempts (threshold not reached ⇒ endpoint stays enabled)", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  const deps = { endpoints, deliveries, sender: failSender, autoDisableThreshold: 20, concurrency: 5, now: () => 1000 };
  await makeDispatchEvent(deps)(EV);
  let now = 2000;
  for (let i = 0; i < 8; i++) {
    await sweepWebhookDeliveries(deps, now);
    now += BACKOFF_OFFSETS_MS[BACKOFF_OFFSETS_MS.length - 1]! + 1;
  }
  const d = (await deliveries.listForEndpoint(e.id, null, 10))[0]!;
  assert.equal(d.status, "exhausted");
  assert.equal(d.attemptCount, 8);
  assert.equal((await endpoints.get(e.id))!.enabled, true); // 8 failures < threshold 20
});

test("auto-disable fires once sustained failures cross the threshold", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  const deps = { endpoints, deliveries, sender: failSender, autoDisableThreshold: 3, concurrency: 5, now: () => 1000 };
  await makeDispatchEvent(deps)(EV);
  let now = 2000;
  // Three failing attempts bump the counter to the threshold → auto-disable.
  for (let i = 0; i < 3; i++) {
    await sweepWebhookDeliveries(deps, now);
    now += BACKOFF_OFFSETS_MS[BACKOFF_OFFSETS_MS.length - 1]! + 1;
  }
  const ep = (await endpoints.get(e.id))!;
  assert.equal(ep.enabled, false);
  assert.match(ep.disabledReason ?? "", /sustained/);
});

test("a blocked (SSRF/host) result is non-retryable: status=failed on the first sweep", async () => {
  const { endpoints, deliveries } = makeStores();
  const e = await endpoints.create(epInput());
  const deps = { endpoints, deliveries, sender: blockedSender, autoDisableThreshold: 20, concurrency: 5, now: () => 1000 };
  await makeDispatchEvent(deps)(EV);
  await sweepWebhookDeliveries(deps, 2000);
  const d = (await deliveries.listForEndpoint(e.id, null, 10))[0]!;
  assert.equal(d.status, "failed");
  // blocked does NOT count toward auto-disable
  assert.equal((await endpoints.get(e.id))!.consecutiveFailures, 0);
});
