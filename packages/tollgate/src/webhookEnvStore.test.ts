import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvConfigStore } from "./webhookEnvStore.ts";
import type { WebhookEndpointSpec } from "@naulon/shared";

const specs: WebhookEndpointSpec[] = [
  { url: "https://a.test/h", secret: "s1", events: ["settlement.completed"], hostFilter: null },
  { url: "https://b.test/h", secret: "s2", events: ["anomaly.detected"], hostFilter: "b.test" },
];

test("listDeliverable returns endpoints subscribed to the event type, with secret", async () => {
  const store = new EnvConfigStore(specs);
  const got = await store.listDeliverable("self-host", "settlement.completed");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.url, "https://a.test/h");
  assert.equal(got[0]!.secret, "s1");
  assert.equal(got[0]!.channelType, "raw");
  assert.equal(got[0]!.enabled, true);
});

test("get resolves a synthesized id; unknown id → null", async () => {
  const store = new EnvConfigStore(specs);
  const ep = await store.get("env:1");
  assert.equal(ep?.url, "https://b.test/h");
  assert.equal(await store.get("env:99"), null);
});

test("mutations throw — env config is immutable", async () => {
  const store = new EnvConfigStore(specs);
  await assert.rejects(() => store.create({} as never), /immutable|read-only/i);
  await assert.rejects(() => store.update("env:0", {}), /immutable|read-only/i);
  await assert.rejects(() => store.delete("env:0"), /immutable|read-only/i);
});

test("bumpFailures counts in memory; resetFailures clears it", async () => {
  const store = new EnvConfigStore(specs);
  assert.equal(await store.bumpFailures("env:0"), 1);
  assert.equal(await store.bumpFailures("env:0"), 2);
  await store.resetFailures("env:0");
  assert.equal(await store.bumpFailures("env:0"), 1);
});

test("the failure count is READABLE off the endpoint, not just returned by bumpFailures", async () => {
  // The counters used to live in a side map nothing read back, so consecutiveFailures reported 0
  // however many times an endpoint had failed. Asserting only bumpFailures' return value is what
  // let that through — this asserts what every actual consumer reads.
  const store = new EnvConfigStore(specs);
  await store.bumpFailures("env:0");
  await store.bumpFailures("env:0");

  assert.equal((await store.get("env:0"))?.consecutiveFailures, 2);
  assert.equal((await store.listForOwner("self-host"))[0]?.consecutiveFailures, 2);
  assert.equal((await store.listForOwner("self-host"))[1]?.consecutiveFailures, 0, "scoped to the one endpoint");

  await store.resetFailures("env:0");
  assert.equal((await store.get("env:0"))?.consecutiveFailures, 0);
});

test("autoDisable stamps WHY, so a gate-abandoned endpoint is distinguishable from an off one", async () => {
  const store = new EnvConfigStore(specs);
  await store.autoDisable("env:0", "20 consecutive failures", 1_700_000_000_000);

  const ep = await store.get("env:0");
  assert.equal(ep?.enabled, false);
  assert.equal(ep?.disabledAt, 1_700_000_000_000);
  assert.equal(ep?.disabledReason, "20 consecutive failures");
  // ...and it stops being deliverable, which is the point of disabling it.
  assert.deepEqual(await store.listDeliverable("self-host", "settlement.completed"), []);
});

test("reads hand out copies — a caller mutating a row cannot reach into the store", async () => {
  const store = new EnvConfigStore(specs);
  const rows = await store.listForOwner("self-host");
  rows[0]!.enabled = false;
  rows[0]!.eventTypes.push("anomaly.detected");

  const fresh = await store.get("env:0");
  assert.equal(fresh?.enabled, true);
  assert.deepEqual(fresh?.eventTypes, ["settlement.completed"]);
});

test("an empty spec list is a valid, deliverable-free store (dark)", async () => {
  const store = new EnvConfigStore([]);
  assert.deepEqual(await store.listForOwner("self-host"), []);
  assert.deepEqual(await store.listDeliverable("self-host", "settlement.completed"), []);
});
