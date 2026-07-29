import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type WebhookDelivery } from "@naulon/shared";
import {
  buildWebhooksView,
  deliveryStore,
  maskSecret,
  queuePing,
  resendDelivery,
  toEndpointView,
  trailingFailures,
} from "./webhooks.ts";

/** Obviously-fake fixture secrets, ASSEMBLED rather than written as one literal: a 20+ character
 *  string against a `secret:` key is precisely the shape the repo's secret guard blocks, and it is
 *  right to. Keeping the fixtures out of that shape keeps the guard meaningful. */
const fake = (tail: string): string => `whsec_${tail}`;
const SECRET_A = fake("abcdefghijklmnop");
const SECRET_B = fake("zzzzzzzzzzzzzzzz");

/** Point config at a fresh journal + a given endpoint list, the way the operator's env would. */
function withEnv(endpoints: unknown[] | string | undefined, sweepMs = "30000"): void {
  process.env["WEBHOOK_DELIVERIES_PATH"] = join(mkdtempSync(join(tmpdir(), "naulon-console-wh-")), "deliveries.jsonl");
  process.env["WEBHOOK_SWEEP_INTERVAL_MS"] = sweepMs;
  if (endpoints === undefined) delete process.env["NAULON_WEBHOOK_ENDPOINTS"];
  else process.env["NAULON_WEBHOOK_ENDPOINTS"] = typeof endpoints === "string" ? endpoints : JSON.stringify(endpoints);
  resetConfig();
}

const one = (): Record<string, unknown> => ({
  url: "https://hook.test/naulon",
  secret: SECRET_A,
  events: ["settlement.completed"],
});

const queued = (endpointId: string, eventId: string) =>
  ({ endpointId, eventType: "ping", eventId, host: null, payload: {}, nextAttemptAt: 1 }) as const;

function delivery(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: "d",
    endpointId: "env:0",
    eventType: "settlement.completed",
    eventId: "e",
    host: null,
    payload: {},
    status: "delivered",
    attemptCount: 1,
    nextAttemptAt: null,
    lastAttemptAt: 10,
    lastStatusCode: 200,
    lastResponseBody: null,
    lastError: null,
    createdAt: 10,
    ...over,
  };
}

/* ── the credential wall ─────────────────────────────────────────────────────────────── */

test("maskSecret keeps the prefix and the tail, never the middle", () => {
  assert.equal(maskSecret(SECRET_A), "whsec_…mnop");
  assert.equal(maskSecret("plainlongsecretvalue"), "…alue");
});

test("a secret too short to mask safely collapses entirely", () => {
  // Showing "most of" a short secret is worse than showing none of it.
  assert.equal(maskSecret(fake("abc")), "whsec_…");
  assert.equal(maskSecret("short"), "…");
});

test("the view never carries the raw secret — in any mode", async () => {
  withEnv([one()]);
  const view = await buildWebhooksView();
  const serialized = JSON.stringify(view);

  assert.equal(view.endpoints[0]?.secretMasked, "whsec_…mnop");
  assert.equal(serialized.includes(SECRET_A), false, "the raw signing key must not reach the browser");
  assert.equal("secret" in (view.endpoints[0] ?? {}), false, "there is no raw field to forget to mask");
});

/* ── derived endpoint health ─────────────────────────────────────────────────────────── */

test("trailingFailures counts back to the first delivery that landed", () => {
  assert.equal(trailingFailures([delivery({ status: "failed" }), delivery({ status: "exhausted" }), delivery()]), 2);
  assert.equal(trailingFailures([delivery(), delivery({ status: "failed" })]), 0, "the newest landed → healthy");
  assert.equal(trailingFailures([]), 0);
});

test("a pending delivery neither counts as a failure nor resets the run", () => {
  // In flight = no verdict. Counting it would make the number swing on nothing but timing.
  const rows = [delivery({ status: "pending" }), delivery({ status: "failed" }), delivery({ status: "failed" })];
  assert.equal(trailingFailures(rows), 2);
});

test("toEndpointView rolls up counts and the newest status", () => {
  const v = toEndpointView(
    { url: "https://hook.test/x", secret: SECRET_A, events: ["settlement.completed"], hostFilter: "a.test" },
    2,
    [delivery({ status: "failed", lastAttemptAt: 99 }), delivery(), delivery({ status: "exhausted" })],
  );
  assert.equal(v.id, "env:2");
  assert.equal(v.channelType, "raw");
  assert.equal(v.hostFilter, "a.test");
  assert.deepEqual(v.counts, { total: 3, pending: 0, delivered: 1, failed: 1, exhausted: 1 });
  assert.equal(v.lastStatus, "failed");
  assert.equal(v.lastAttemptAt, 99);
});

/* ── the view ────────────────────────────────────────────────────────────────────────── */

test("no endpoints configured ⇒ dark, and it says so rather than looking broken", async () => {
  withEnv(undefined);
  const view = await buildWebhooksView();
  assert.equal(view.configured, false);
  assert.equal(view.envError, null);
  assert.deepEqual(view.endpoints, []);
});

test("a malformed endpoint list is REPORTED, not thrown at the page", async () => {
  // parseWebhookEndpointsEnv throws by design so a self-hoster learns at boot. A console page that
  // 500s because of it teaches nothing — the message is the whole value.
  withEnv('[{"url":"http://not-https.test/h","secret":"s"}]');
  const view = await buildWebhooksView();
  assert.equal(view.configured, false);
  assert.match(view.envError ?? "", /must be https/);
});

test("deliveries are joined to the endpoint that owns them", async () => {
  withEnv([one(), { url: "https://second.test/h", secret: SECRET_B, events: ["anomaly.detected"] }]);
  const store = deliveryStore();
  await store.enqueue(queued("env:0", "p1"));
  await store.enqueue(queued("env:1", "p2"));
  await store.enqueue(queued("env:1", "p3"));

  const view = await buildWebhooksView();
  assert.equal(view.endpoints[0]?.counts.total, 1);
  assert.equal(view.endpoints[1]?.counts.total, 2);
  assert.equal(view.deliveries.length, 3, "the log carries every endpoint's rows");
});

test("dead letters are counted for the operator", async () => {
  withEnv([one()]);
  const store = deliveryStore();
  const d = await store.enqueue(queued("env:0", "p"));
  await store.recordAttempt(d.id, { status: "exhausted" });

  assert.equal((await buildWebhooksView()).deadLettered, 1);
});

/* ── ping ────────────────────────────────────────────────────────────────────────────── */

test("ping queues a real delivery on the gate's own path", async () => {
  withEnv([one()]);
  const res = await queuePing("env:0", 5_000);
  assert.equal(res.ok, true);

  const rows = await deliveryStore().listAll(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.eventType, "ping");
  assert.equal(rows[0]?.status, "pending");
  assert.equal(rows[0]?.nextAttemptAt, 5_000, "due now, so the next sweep takes it");
});

test("a second ping is a second delivery, not deduped into the first", async () => {
  withEnv([one()]);
  await queuePing("env:0", 1_000);
  await queuePing("env:0", 2_000);
  assert.equal((await deliveryStore().listAll(10)).length, 2);
});

test("ping refuses an endpoint that is not in the operator's own env", async () => {
  withEnv([one()]);
  // The target is resolved from configuration by index — a request can never name a host.
  assert.deepEqual(await queuePing("env:9"), { ok: false, error: "unknown endpoint" });
  assert.deepEqual(await queuePing("https://attacker.test/h"), { ok: false, error: "unknown endpoint" });
  assert.equal((await deliveryStore().listAll(10)).length, 0);
});

test("ping carries the endpoint's host filter, and null when it serves every site", async () => {
  withEnv([{ ...one(), hostFilter: "a.test" }, one()]);
  await queuePing("env:0", 1);
  await queuePing("env:1", 2);
  const rows = await deliveryStore().listAll(10);
  assert.equal(rows.find((r) => r.endpointId === "env:0")?.host, "a.test");
  assert.equal(rows.find((r) => r.endpointId === "env:1")?.host, null);
});

/* ── resend ──────────────────────────────────────────────────────────────────────────── */

test("resend re-queues a failed delivery with a fresh attempt budget", async () => {
  withEnv([one()]);
  const store = deliveryStore();
  const d = await store.enqueue(queued("env:0", "p"));
  await store.recordAttempt(d.id, { status: "failed", attemptCount: 4, lastError: "500" });

  assert.deepEqual(await resendDelivery(d.id, 9_000), { ok: true });
  const row = await deliveryStore().get(d.id);
  assert.equal(row?.status, "pending");
  assert.equal(row?.attemptCount, 0);
  assert.equal(row?.nextAttemptAt, 9_000);
  assert.equal(row?.lastError, null);
});

test("resend refuses an unknown delivery, and one that is already queued", async () => {
  withEnv([one()]);
  const store = deliveryStore();
  const d = await store.enqueue(queued("env:0", "p"));

  assert.equal((await resendDelivery("nope")).ok, false);
  // Re-queuing a queued delivery would report success and change nothing — an honest no-op instead.
  assert.deepEqual(await resendDelivery(d.id), { ok: false, error: "that delivery is already queued" });
});
