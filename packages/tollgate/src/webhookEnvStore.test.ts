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

test("an empty spec list is a valid, deliverable-free store (dark)", async () => {
  const store = new EnvConfigStore([]);
  assert.deepEqual(await store.listForOwner("self-host"), []);
  assert.deepEqual(await store.listDeliverable("self-host", "settlement.completed"), []);
});
