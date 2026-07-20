/**
 * Settlement delivery durability: the drain must select only DUE work, count attempts
 * ACROSS sweeps, back off exponentially, dead-letter a permanently-failing event instead
 * of retrying it forever, and never retry a dead letter until an operator revives it.
 *
 * The property that governs every assertion here: NOTHING IS EVER DROPPED. A dead letter
 * is parked and visible, still owed, still revivable. There is no age cutoff to test
 * because there deliberately isn't one.
 *
 * The drain is driven against an injected in-memory store, so these tests pin the drain's
 * BEHAVIOUR without a database. Config is set before the first getConfig() binds.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "naulon-delivery-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.SETTLEMENT_OUTBOX_PATH = join(dir, "outbox.jsonl");
process.env.SETTLEMENT_DELIVERY_STATE_PATH = join(dir, "delivery.jsonl");
process.env.EVENTS_BACKEND = "jsonl";
// One POST per sweep, so a "sweep" is unambiguous and nothing sleeps through a ladder.
process.env.SETTLEMENT_MAX_ATTEMPTS = "1";
// Small, exact numbers so the backoff ladder is asserted, not approximated.
process.env.SETTLEMENT_MAX_DELIVERY_ATTEMPTS = "3";
process.env.SETTLEMENT_RETRY_BASE_MS = "1000";
process.env.SETTLEMENT_RETRY_BACKOFF_CAP_MS = "4000";

const { drainSettlements } = await import("./settlementSink.ts");
const { backoffMs, memorySettlementDeliveryStore, setSettlementDeliveryStore } = await import(
  "./settlementDelivery.ts"
);
import type { SettlementDeliveryStore } from "./settlementDelivery.ts";
import type { AttributedEvent, Usdc, WalletAddress } from "@naulon/shared";

const AUTHOR = "0x1111111111111111111111111111111111111111" as WalletAddress;
const PAYER = "0x3333333333333333333333333333333333333333" as WalletAddress;

function evt(id: string, publisherId: string, at = 1_700_000_000_000): AttributedEvent {
  return {
    id,
    publisherId,
    slug: "on-stillness",
    kind: "read",
    amount: 1000 as Usdc,
    payees: [{ authorId: "author-1", wallet: AUTHOR, share: 1 }],
    payerAddress: PAYER,
    settlementRef: "0xfeed",
    at,
  };
}

/** Swap fetch for one that always returns `status`, counting calls. */
function fetchReturning(status: number): { count: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { count: () => n };
}

/** Install a memory store seeded with `events` and hand it back for direct inspection. */
function withStore(events: AttributedEvent[]): SettlementDeliveryStore {
  const store = memorySettlementDeliveryStore(events);
  setSettlementDeliveryStore(store);
  return store;
}

const sweep = (publisherId: string): Promise<{ acked: number; pending: number; deadLettered: number }> =>
  drainSettlements({ secret: "s", originUrl: "https://origin.example", publisherId });

// ── The backoff policy itself ────────────────────────────────────────────────────────

test("backoff doubles per attempt and then holds at the cap", () => {
  // base 1m, cap 6h — the shipped defaults, asserted directly so a config change that
  // silently flattens the ladder is a red test rather than a quiet regression.
  const base = 60_000;
  const cap = 21_600_000;
  assert.equal(backoffMs(1, base, cap), 60_000); // 1m
  assert.equal(backoffMs(2, base, cap), 120_000); // 2m
  assert.equal(backoffMs(3, base, cap), 240_000); // 4m
  assert.equal(backoffMs(9, base, cap), 15_360_000); // 4h16m — still under the cap
  assert.equal(backoffMs(10, base, cap), cap, "clamped, not doubled past the cap");
  assert.equal(backoffMs(500, base, cap), cap, "a pathological count can never overflow to Infinity");
});

// ── Due-selection ────────────────────────────────────────────────────────────────────

test("a due event is swept and a not-yet-due one is not", async () => {
  const store = withStore([evt("due-1", "p-due")]);
  const f = fetchReturning(500); // transient failure → the event is left pending

  const first = await sweep("p-due");
  assert.deepEqual(first, { acked: 0, pending: 1, deadLettered: 0 });
  assert.equal(f.count(), 1, "the never-attempted event was due");

  // The failure pushed next_attempt_at out by the base backoff (1s here), so an
  // IMMEDIATE second sweep must find nothing. Before this change the drain re-read the
  // whole ledger and re-POSTed every unacked event on every tick, forever.
  const second = await sweep("p-due");
  assert.deepEqual(second, { acked: 0, pending: 0, deadLettered: 0 });
  assert.equal(f.count(), 1, "no second POST — the event is backing off, not due");

  const [state] = await store.deadLettered({ limit: 10 });
  assert.equal(state, undefined, "one failure of a budget of three is not a dead letter");
});

// ── Attempts + growing backoff across sweeps ─────────────────────────────────────────

test("attempts accumulate across sweeps and the backoff grows", async () => {
  const store = withStore([evt("grow-1", "p-grow")]);
  fetchReturning(500);

  const at = 10_000_000;
  const s1 = await store.markFailed({
    eventId: "grow-1", publisherId: "p-grow", now: at,
    error: "boom", maxAttempts: 5, baseMs: 1000, capMs: 60_000,
  });
  assert.equal(s1.attempts, 1);
  assert.equal(s1.nextAttemptAt - at, 1000);

  const s2 = await store.markFailed({
    eventId: "grow-1", publisherId: "p-grow", now: at,
    error: "boom", maxAttempts: 5, baseMs: 1000, capMs: 60_000,
  });
  assert.equal(s2.attempts, 2, "the count PERSISTS across sweeps — it does not reset");
  assert.equal(s2.nextAttemptAt - at, 2000, "and the wait doubled");

  const s3 = await store.markFailed({
    eventId: "grow-1", publisherId: "p-grow", now: at,
    error: "boom", maxAttempts: 5, baseMs: 1000, capMs: 60_000,
  });
  assert.equal(s3.attempts, 3);
  assert.equal(s3.nextAttemptAt - at, 4000);
  assert.equal(s3.lastError, "boom", "the reason is carried for the operator to read");
});

// ── Dead-lettering ───────────────────────────────────────────────────────────────────

/** Run `n` sweeps, forcing the event due again between them (the clock is not mockable
 *  through Date.now here, so we reset the backoff to simulate time passing). */
async function sweepTimes(store: SettlementDeliveryStore, publisherId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sweep(publisherId);
    // Make it due again unless it dead-lettered — revive() deliberately refuses a
    // non-dead-lettered row, so this only advances the clock for the living.
    const dead = await store.deadLettered({ limit: 10 });
    if (dead.length > 0) break;
    await store.markFailed({
      eventId: "dead-1", publisherId, now: 0, error: "clock", maxAttempts: 999, baseMs: 0, capMs: 0,
    });
  }
}

test("the Nth consecutive failure dead-letters the event", async () => {
  const store = withStore([evt("dead-1", "p-dead")]);
  const f = fetchReturning(500);

  // SETTLEMENT_MAX_DELIVERY_ATTEMPTS = 3 in this suite. Each loop is one real sweep plus
  // a clock nudge; the third recorded failure crosses the budget.
  await sweepTimes(store, "p-dead", 6);

  const dead = await store.deadLettered({ limit: 10 });
  assert.equal(dead.length, 1, "the budget ran out and the event parked");
  assert.equal(dead[0]!.eventId, "dead-1");
  assert.ok(dead[0]!.deadLetteredAt !== undefined);
  assert.ok(dead[0]!.attempts >= 3);
  assert.ok(f.count() >= 2, "it really was attempted, repeatedly, before parking");
});

test("a dead-lettered event is NOT retried by an ordinary sweep", async () => {
  const store = withStore([evt("dead-1", "p-quiet")]);
  // Park it directly at the budget so the state is unambiguous.
  await store.markFailed({
    eventId: "dead-1", publisherId: "p-quiet", now: 1,
    error: "gone", maxAttempts: 1, baseMs: 0, capMs: 0,
  });
  assert.equal((await store.deadLettered({ limit: 10 })).length, 1);

  const f = fetchReturning(500);
  const summary = await sweep("p-quiet");

  assert.deepEqual(summary, { acked: 0, pending: 0, deadLettered: 0 });
  assert.equal(f.count(), 0, "a parked event is not re-POSTed — that is the whole point of parking it");
  // And it is still there. Parked, not dropped: the money is still owed.
  assert.equal((await store.deadLettered({ limit: 10 })).length, 1);
});

test("an operator revive makes a dead-lettered event due again", async () => {
  const store = withStore([evt("dead-1", "p-revive")]);
  await store.markFailed({
    eventId: "dead-1", publisherId: "p-revive", now: 1,
    error: "gone", maxAttempts: 1, baseMs: 0, capMs: 0,
  });

  assert.equal(await store.revive("dead-1", Date.now()), true, "the revive won");
  assert.equal((await store.deadLettered({ limit: 10 })).length, 0, "off the stuck-money list");

  const f = fetchReturning(200);
  const summary = await sweep("p-revive");
  assert.deepEqual(summary, { acked: 1, pending: 0, deadLettered: 0 }, "the next ordinary sweep picked it up");
  assert.equal(f.count(), 1);

  // Reviving something that is not dead-lettered is an honest no-op, not a silent success.
  assert.equal(await store.revive("dead-1", Date.now()), false);
  assert.equal(await store.revive("no-such-event", Date.now()), false);
});

// ── Success is terminal ──────────────────────────────────────────────────────────────

test("a delivered settlement is marked acked and never re-sent", async () => {
  const store = withStore([evt("ack-1", "p-ack")]);
  const f = fetchReturning(200);

  assert.deepEqual(await sweep("p-ack"), { acked: 1, pending: 0, deadLettered: 0 });
  assert.equal(await store.isAcked("ack-1"), true);

  // Three more sweeps: an acked event must never appear in the due set again.
  await sweep("p-ack");
  await sweep("p-ack");
  await sweep("p-ack");
  assert.equal(f.count(), 1, "exactly one POST for one settlement, across four sweeps");
});

test("an ack clears a dead letter — the money got through, so it leaves the stuck list", async () => {
  const store = withStore([evt("ack-2", "p-ack2")]);
  await store.markFailed({
    eventId: "ack-2", publisherId: "p-ack2", now: 1,
    error: "gone", maxAttempts: 1, baseMs: 0, capMs: 0,
  });
  assert.equal((await store.deadLettered({ limit: 10 })).length, 1);

  await store.markAcked("ack-2", "p-ack2", Date.now());
  assert.equal((await store.deadLettered({ limit: 10 })).length, 0);
});

// ── Tenant isolation on the operator read ────────────────────────────────────────────

test("the dead-letter read is scoped by publisher and an empty scope returns nothing", async () => {
  const store = withStore([]);
  for (const [id, pub] of [["x1", "tenant-x"], ["y1", "tenant-y"]] as const) {
    await store.markFailed({ eventId: id, publisherId: pub, now: 1, error: "e", maxAttempts: 1, baseMs: 0, capMs: 0 });
  }

  const x = await store.deadLettered({ publisherIds: ["tenant-x"], limit: 10 });
  assert.deepEqual(x.map((s) => s.eventId), ["x1"], "tenant-x must never see tenant-y's stuck money");

  // An empty allow-list means "no tenants", never "all tenants" — the fail-closed direction.
  assert.deepEqual(await store.deadLettered({ publisherIds: [], limit: 10 }), []);
});

// ── Dark by default ──────────────────────────────────────────────────────────────────

test("the no-secret dark path is still a no-op and never touches the delivery store", async () => {
  // A store that throws on every method: if the dark path consulted it at all, this fails.
  const exploding = new Proxy({} as SettlementDeliveryStore, {
    get: () => () => {
      throw new Error("the dark path must not touch the delivery store");
    },
  });
  setSettlementDeliveryStore(exploding);
  const f = fetchReturning(200);

  assert.deepEqual(await drainSettlements({ publisherId: "p-dark" }), { acked: 0, pending: 0, deadLettered: 0 });
  assert.equal(f.count(), 0, "no creds, no emit — the self-host offline loop stays creds-free");

  setSettlementDeliveryStore(undefined);
});
