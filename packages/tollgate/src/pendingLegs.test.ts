/**
 * PendingLegSink (memory backend) unit tests — the deferred-extra-leg store behind O5/O1.
 * The branchy parts that must be exactly right: idempotent record (a buyer retry can't
 * duplicate a leg), the pending filter (settled + expired + publisher scope), and the
 * atomic markSettled (settle exactly once across concurrent drains).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryPendingLegSink, type PendingLeg } from "./pendingLegs.ts";

function leg(id: string, over: Partial<PendingLeg> = {}): PendingLeg {
  return {
    id,
    publisherId: "pub-1",
    role: "operator",
    payTo: "0x3333333333333333333333333333333333333333",
    amount: "500",
    payload: { nonce: id },
    requirements: {} as PendingLeg["requirements"],
    validBefore: 10_000,
    at: 1_000,
    ...over,
  };
}

test("record is idempotent on leg id — a buyer retry never duplicates", async () => {
  const sink = memoryPendingLegSink();
  await sink.record(leg("n1"));
  await sink.record(leg("n1", { amount: "999" })); // same id, different content → ignored
  const pending = await sink.pending(5_000);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.amount, "500", "first write wins; the retry is a no-op");
});

test("pending filters settled, expired, and by publisher scope", async () => {
  const sink = memoryPendingLegSink([
    leg("a", { publisherId: "pub-1", validBefore: 10_000 }),
    leg("b", { publisherId: "pub-2", validBefore: 10_000 }),
    leg("c", { publisherId: "pub-1", validBefore: 2_000 }), // expires before `now`
  ]);
  // now=5000: c is expired (validBefore 2000), b is another publisher.
  assert.deepEqual((await sink.pending(5_000, "pub-1")).map((l) => l.id), ["a"]);
  // unscoped sees both live legs (a, b), still excludes the expired c.
  assert.deepEqual((await sink.pending(5_000)).map((l) => l.id).sort(), ["a", "b"]);
  // mark a settled → it drops out of pending.
  await sink.markSettled("a", "ref-a");
  assert.deepEqual((await sink.pending(5_000, "pub-1")).map((l) => l.id), []);
});

test("markSettled is atomic compare-and-set — exactly one winner (O1)", async () => {
  const sink = memoryPendingLegSink([leg("x")]);
  assert.equal(await sink.markSettled("x", "ref-1"), true, "first call wins the transition");
  assert.equal(await sink.markSettled("x", "ref-2"), false, "second call loses — already settled");
  assert.equal(await sink.markSettled("missing", "ref"), false, "unknown id → not us");
});

test("pending returns oldest-first (drain order)", async () => {
  const sink = memoryPendingLegSink([
    leg("late", { at: 3_000 }),
    leg("early", { at: 1_000 }),
    leg("mid", { at: 2_000 }),
  ]);
  assert.deepEqual((await sink.pending(5_000)).map((l) => l.id), ["early", "mid", "late"]);
});
