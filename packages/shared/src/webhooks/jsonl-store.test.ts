import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlWebhookDeliveryStore } from "./jsonl-store.ts";
import type { JsonlWebhookDeliveryStoreOptions } from "./jsonl-store.ts";

async function tmpJournal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "naulon-wh-"));
  return join(dir, "webhook-deliveries.jsonl");
}

function store(path: string, over: Partial<JsonlWebhookDeliveryStoreOptions> = {}): JsonlWebhookDeliveryStore {
  return new JsonlWebhookDeliveryStore({ path, ...over });
}

const enqueued = { endpointId: "env:0", eventType: "ping", eventId: "e1", host: null, payload: { a: 1 }, nextAttemptAt: 100 } as const;

test("enqueue persists to disk and reads back with pending defaults", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const d = await s.enqueue({ ...enqueued });

  assert.equal(d.status, "pending");
  assert.equal(d.attemptCount, 0);
  assert.equal(d.lastStatusCode, null);

  // The point of the file: a SECOND store instance (i.e. the dashboard process) sees it.
  const other = store(path);
  assert.deepEqual((await other.get(d.id))?.payload, { a: 1 });
});

test("enqueue is idempotent on (endpointId,eventId) — returns the existing row, writes no second one", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const first = await s.enqueue({ ...enqueued });
  const again = await s.enqueue({ ...enqueued, payload: { a: 999 } });

  assert.equal(again.id, first.id);
  assert.deepEqual(again.payload, { a: 1 }, "the existing row wins, the duplicate body is discarded");
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
});

test("recordAttempt appends a new line and the later line wins on replay", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const d = await s.enqueue({ ...enqueued });
  await s.recordAttempt(d.id, { status: "delivered", attemptCount: 1, lastStatusCode: 200 });

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2, "append-only: the journal keeps both");

  const fresh = store(path);
  const row = await fresh.get(d.id);
  assert.equal(row?.status, "delivered");
  assert.equal(row?.lastStatusCode, 200);
});

test("a write by ANOTHER process is picked up — the cache revalidates on mtime+size", async () => {
  const path = await tmpJournal();
  const reader = store(path);
  const writer = store(path);

  const d = await writer.enqueue({ ...enqueued });
  assert.equal((await reader.get(d.id))?.status, "pending", "reader has now cached the journal");

  await writer.recordAttempt(d.id, { status: "delivered", attemptCount: 1 });

  // The reader never wrote and never dropped its own cache. A cache held forever (the way the
  // single-writer settlement store holds its own) would still answer "pending" here.
  assert.equal((await reader.get(d.id))?.status, "delivered");
});

test("a torn line is skipped, not thrown on — one bad line cannot take down the delivery view", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const good = await s.enqueue({ ...enqueued });
  await writeFile(path, (await readFile(path, "utf8")) + '{"id":"truncated","endpo\n', "utf8");

  const rows = await s.listAll(50);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, good.id);
});

test("listDue returns only pending rows that are due, oldest-first", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const soon = await s.enqueue({ ...enqueued, eventId: "soon", nextAttemptAt: 100 });
  const later = await s.enqueue({ ...enqueued, eventId: "later", nextAttemptAt: 200 });
  await s.enqueue({ ...enqueued, eventId: "future", nextAttemptAt: 9_999 });
  const done = await s.enqueue({ ...enqueued, eventId: "done", nextAttemptAt: 50 });
  await s.recordAttempt(done.id, { status: "delivered" });

  const due = await s.listDue(1_000, 10);
  assert.deepEqual(
    due.map((d) => d.id),
    [soon.id, later.id],
  );
});

test("claimDue leases a row so a second claim in the same process skips it until the lease lapses", async () => {
  const path = await tmpJournal();
  const s = store(path);
  await s.enqueue({ ...enqueued, nextAttemptAt: 10 });

  assert.equal((await s.claimDue(1_000, 10, 60_000)).length, 1);
  assert.equal((await s.claimDue(1_000, 10, 60_000)).length, 0, "still leased");
  assert.equal((await s.claimDue(120_000, 10, 60_000)).length, 1, "lease lapsed");
});

test("revive only resurrects an exhausted row, and makes it due now", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const d = await s.enqueue({ ...enqueued });

  assert.equal(await s.revive(d.id, 500), false, "pending is not a dead letter");
  await s.recordAttempt(d.id, { status: "exhausted", attemptCount: 6 });
  assert.equal(await s.revive(d.id, 500), true);

  const row = await s.get(d.id);
  assert.equal(row?.status, "pending");
  assert.equal(row?.nextAttemptAt, 500);
  assert.equal(row?.attemptCount, 6, "revive does not erase the attempt history");
});

test("deadLettered scopes by host — an empty host list returns nothing, undefined returns every host", async () => {
  const path = await tmpJournal();
  const s = store(path);
  const a = await s.enqueue({ ...enqueued, eventId: "a", host: "a.test" });
  const b = await s.enqueue({ ...enqueued, eventId: "b", host: "b.test" });
  await s.recordAttempt(a.id, { status: "exhausted" });
  await s.recordAttempt(b.id, { status: "exhausted" });

  assert.equal((await s.deadLettered({ limit: 10 })).length, 2);
  assert.equal((await s.deadLettered({ hosts: [], limit: 10 })).length, 0);
  assert.deepEqual((await s.deadLettered({ hosts: ["b.test"], limit: 10 })).map((d) => d.host), ["b.test"]);
});

test("listForEndpoint pages backwards by createdAt cursor, newest first", async () => {
  const path = await tmpJournal();
  let clock = 1_000;
  const s = store(path, { now: () => (clock += 10) });
  await s.enqueue({ ...enqueued, eventId: "1" });
  await s.enqueue({ ...enqueued, eventId: "2" });
  await s.enqueue({ ...enqueued, eventId: "3" });
  await s.enqueue({ ...enqueued, endpointId: "env:1", eventId: "other" });

  const page1 = await s.listForEndpoint("env:0", null, 2);
  assert.deepEqual(page1.map((d) => d.eventId), ["3", "2"]);
  const page2 = await s.listForEndpoint("env:0", page1[1]!.createdAt, 2);
  assert.deepEqual(page2.map((d) => d.eventId), ["1"]);
});

test("compaction keeps every unsent delivery however old, and never loses one to a crash", async () => {
  const path = await tmpJournal();
  let clock = 0;
  // compactAtLines:3 so the fourth append triggers it; keepDelivered:1 so old delivered rows drop.
  const s = store(path, { now: () => (clock += 1), compactAtLines: 3, keepDelivered: 1 });

  const owed = await s.enqueue({ ...enqueued, eventId: "owed" }); // oldest, still pending
  const d1 = await s.enqueue({ ...enqueued, eventId: "d1" });
  const d2 = await s.enqueue({ ...enqueued, eventId: "d2" });
  await s.recordAttempt(d1.id, { status: "delivered" });
  await s.recordAttempt(d2.id, { status: "delivered" });

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.ok(lines.length <= 3, `compacted, got ${lines.length} lines`);

  const fresh = store(path);
  const ids = (await fresh.listAll(50)).map((d) => d.id);
  assert.ok(ids.includes(owed.id), "the oldest UNSENT delivery survives compaction — it is still owed");
  assert.ok(ids.includes(d2.id), "the newest delivered row is kept for the operator's log");
  assert.equal(ids.includes(d1.id), false, "the older delivered row is dropped past keepDelivered");
});

test("a missing journal reads as empty rather than throwing", async () => {
  const s = store(join(await tmpJournal(), "..", "nope", "deliveries.jsonl"));
  assert.deepEqual(await s.listAll(10), []);
  assert.equal(await s.get("whatever"), null);
});
