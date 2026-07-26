import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryWebhookEndpointStore, MemoryWebhookDeliveryStore } from "./memory-store.ts";
import type { NewWebhookEndpoint } from "./types.ts";

function ep(over: Partial<NewWebhookEndpoint> = {}): NewWebhookEndpoint {
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

test("listDeliverable returns only enabled, subscribed, owner-matched", async () => {
  const eps = new MemoryWebhookEndpointStore();
  const a = await eps.create(ep());
  await eps.create(ep({ ownerUserId: "o2" })); // other owner
  await eps.create(ep({ eventTypes: ["settlement.completed"] })); // other event
  const disabled = await eps.create(ep());
  await eps.update(disabled.id, { enabled: false });

  const got = await eps.listDeliverable("o1", "anomaly.detected");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.id, a.id);
});

test("payloadProfile: defaults to summary when omitted; create detailed + patch back round-trips", async () => {
  const eps = new MemoryWebhookEndpointStore();
  const legacy = await eps.create(ep()); // omits payloadProfile
  assert.equal(legacy.payloadProfile, "summary"); // non-breaking default

  const detailed = await eps.create(ep({ payloadProfile: "detailed" }));
  assert.equal(detailed.payloadProfile, "detailed");

  const patched = await eps.update(detailed.id, { payloadProfile: "summary" });
  assert.equal(patched?.payloadProfile, "summary");
  // a patch that omits payloadProfile leaves it untouched
  const untouched = await eps.update(detailed.id, { enabled: true });
  assert.equal(untouched?.payloadProfile, "summary");
});

test("bumpFailures increments + returns; resetFailures zeroes", async () => {
  const eps = new MemoryWebhookEndpointStore();
  const a = await eps.create(ep());
  assert.equal(await eps.bumpFailures(a.id), 1);
  assert.equal(await eps.bumpFailures(a.id), 2);
  await eps.resetFailures(a.id);
  assert.equal((await eps.get(a.id))!.consecutiveFailures, 0);
});

test("autoDisable flips enabled + stamps reason; re-enable via update clears failures", async () => {
  const eps = new MemoryWebhookEndpointStore();
  const a = await eps.create(ep());
  await eps.bumpFailures(a.id);
  await eps.autoDisable(a.id, "auto", 999);
  const got = await eps.get(a.id);
  assert.equal(got!.enabled, false);
  assert.equal(got!.disabledReason, "auto");
  await eps.update(a.id, { enabled: true });
  const re = await eps.get(a.id);
  assert.equal(re!.enabled, true);
  assert.equal(re!.consecutiveFailures, 0);
});

test("enqueue is idempotent on (endpointId,eventId) — second call returns the same row, no dup", async () => {
  const eps = new MemoryWebhookEndpointStore();
  const a = await eps.create(ep());
  const del = new MemoryWebhookDeliveryStore();
  const d1 = await del.enqueue({
    endpointId: a.id,
    eventType: "anomaly.detected",
    eventId: "e1",
    host: null,
    payload: {},
    nextAttemptAt: 1000,
  });
  const d2 = await del.enqueue({
    endpointId: a.id,
    eventType: "anomaly.detected",
    eventId: "e1",
    host: null,
    payload: {},
    nextAttemptAt: 2000,
  });
  assert.equal(d1.id, d2.id);
  assert.equal((await del.listForEndpoint(a.id, null, 10)).length, 1);
});

test("enqueue stamps host; deadLettered returns exhausted, host-scoped, fail-closed", async () => {
  const del = new MemoryWebhookDeliveryStore();
  const mk = (eventId: string, host: string | null) =>
    del.enqueue({ endpointId: "x", eventType: "settlement.completed", eventId, host, payload: {}, nextAttemptAt: 1 });
  const a = await mk("a", "acme.test");
  const b = await mk("b", "beta.test");
  await mk("c", "acme.test"); // stays pending
  await del.recordAttempt(a.id, { status: "exhausted", attemptCount: 8, lastAttemptAt: 100, lastError: "budget spent" });
  await del.recordAttempt(b.id, { status: "exhausted", attemptCount: 8, lastAttemptAt: 200 });

  // undefined hosts → every host's exhausted rows
  assert.deepEqual((await del.deadLettered({ limit: 10 })).map((r) => r.eventId).sort(), ["a", "b"]);
  // scoped to one host
  assert.deepEqual((await del.deadLettered({ hosts: ["acme.test"], limit: 10 })).map((r) => r.eventId), ["a"]);
  // FAIL-CLOSED: empty hosts → nothing (never "all tenants")
  assert.deepEqual(await del.deadLettered({ hosts: [], limit: 10 }), []);
  // pending (c) is never dead-lettered
  assert.ok(!(await del.deadLettered({ limit: 10 })).some((r) => r.eventId === "c"));
  // host is stamped on the row
  assert.equal((await del.get(a.id))!.host, "acme.test");
});

test("revive flips an exhausted delivery back to pending+due; no-op otherwise", async () => {
  const del = new MemoryWebhookDeliveryStore();
  const d = await del.enqueue({ endpointId: "x", eventType: "settlement.completed", eventId: "e", host: "acme.test", payload: {}, nextAttemptAt: 1 });
  await del.recordAttempt(d.id, { status: "exhausted", attemptCount: 8 });
  assert.equal(await del.revive(d.id, 5000), true);
  const revived = (await del.get(d.id))!;
  assert.equal(revived.status, "pending");
  assert.equal(revived.nextAttemptAt, 5000);
  assert.equal(await del.revive(d.id, 6000), false); // no longer exhausted
  assert.equal(await del.revive("nope", 6000), false); // unknown id
});

test("listForOwner never leaks another owner; listDue returns only pending + due", async () => {
  const eps = new MemoryWebhookEndpointStore();
  await eps.create(ep());
  await eps.create(ep({ ownerUserId: "o2" }));
  assert.equal((await eps.listForOwner("o1")).length, 1);

  const del = new MemoryWebhookDeliveryStore();
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "due", host: null, payload: {}, nextAttemptAt: 500 });
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "future", host: null, payload: {}, nextAttemptAt: 5000 });
  const due = await del.listDue(1000, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.eventId, "due");
});

test("recordAttempt patches in place; delivered terminal clears next_attempt_at", async () => {
  const del = new MemoryWebhookDeliveryStore();
  const d = await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "e", host: null, payload: {}, nextAttemptAt: 100 });
  await del.recordAttempt(d.id, { status: "delivered", attemptCount: 1, nextAttemptAt: null, lastStatusCode: 200 });
  const got = await del.get(d.id);
  assert.equal(got!.status, "delivered");
  assert.equal(got!.nextAttemptAt, null);
  assert.equal(got!.lastStatusCode, 200);
  assert.equal((await del.listDue(99999, 10)).length, 0);
});

const LEASE = 60_000;

test("claimDue leases a row — a second concurrent claim at the same instant gets nothing (no double-deliver)", async () => {
  const del = new MemoryWebhookDeliveryStore();
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "e1", host: null, payload: {}, nextAttemptAt: 500 });
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "e2", host: null, payload: {}, nextAttemptAt: 600 });

  const first = await del.claimDue(1000, 10, LEASE);
  assert.equal(first.length, 2, "first sweep claims both due rows");
  const second = await del.claimDue(1000, 10, LEASE);
  assert.equal(second.length, 0, "a racing sweep within the lease claims nothing");
});

test("claimDue: a retry is governed by next_attempt_at, NOT blocked by the lease (recordAttempt clears the claim)", async () => {
  const del = new MemoryWebhookDeliveryStore();
  const d = await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "e", host: null, payload: {}, nextAttemptAt: 500 });
  const claimed = await del.claimDue(1000, 10, LEASE);
  assert.equal(claimed.length, 1);
  // Attempt failed → backoff bumps next_attempt_at 5s out, status stays pending.
  await del.recordAttempt(d.id, { status: "pending", attemptCount: 1, nextAttemptAt: 6000 });
  // At the new due time (well inside the 60s lease window) the retry MUST be claimable.
  const retry = await del.claimDue(6000, 10, LEASE);
  assert.equal(retry.length, 1, "retry fires on its backoff schedule, not after lease expiry");
});

test("claimDue: a crashed worker's row (no recordAttempt) is re-claimable only after the lease expires", async () => {
  const del = new MemoryWebhookDeliveryStore();
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "e", host: null, payload: {}, nextAttemptAt: 500 });
  const claimed = await del.claimDue(1000, 10, LEASE);
  assert.equal(claimed.length, 1);
  // No recordAttempt (the worker died). Within the lease: still claimed → not re-claimable.
  assert.equal((await del.claimDue(1000 + LEASE - 1, 10, LEASE)).length, 0);
  // Past the lease: recovered.
  assert.equal((await del.claimDue(1000 + LEASE + 1, 10, LEASE)).length, 1);
});

test("claimDue honors limit + only pending + only due", async () => {
  const del = new MemoryWebhookDeliveryStore();
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "due1", host: null, payload: {}, nextAttemptAt: 100 });
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "due2", host: null, payload: {}, nextAttemptAt: 200 });
  await del.enqueue({ endpointId: "x", eventType: "anomaly.detected", eventId: "future", host: null, payload: {}, nextAttemptAt: 9000 });
  const one = await del.claimDue(1000, 1, LEASE);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.eventId, "due1", "earliest due first");
});
