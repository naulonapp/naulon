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

// ── The claim seam (broadcast-before-CAS fix) ───────────────────────────────────────────────────
// `markSettled` alone made settle exactly-once for the COUNTER, never for the BROADCAST: the drain
// settled on-chain and compare-and-set after, so a crash in between left a leg whose money had
// moved marked unsettled, to be re-broadcast every sweep until its authorization expired. Claiming
// before the broadcast is what makes the ambiguous window visible and bounded.

test("claim is an atomic compare-and-set — one winner while the lease is live", async () => {
  const sink = memoryPendingLegSink([leg("c1")]);
  assert.equal(await sink.claim!("c1", 5_000, 1_000), true, "first drain wins the claim");
  assert.equal(await sink.claim!("c1", 5_000, 1_000), false, "a concurrent drain must not also broadcast");
});

test("a lapsed claim becomes claimable again — a crashed drain cannot strand a leg", async () => {
  const sink = memoryPendingLegSink([leg("c2")]);
  await sink.claim!("c2", 5_000, 1_000);
  assert.equal(await sink.claim!("c2", 9_000, 4_999), false, "still inside the lease");
  assert.equal(await sink.claim!("c2", 9_000, 5_001), true, "lease lapsed → retryable");
});

test("a settled leg can never be claimed", async () => {
  const sink = memoryPendingLegSink([leg("c3")]);
  await sink.markSettled("c3", "ref");
  assert.equal(await sink.claim!("c3", 5_000, 1_000), false);
  assert.equal(await sink.claim!("missing", 5_000, 1_000), false, "unknown id → not ours");
});

test("release returns a leg immediately, without waiting out the lease", async () => {
  const sink = memoryPendingLegSink([leg("c4")]);
  await sink.claim!("c4", 5_000, 1_000);
  await sink.release!("c4");
  assert.equal(await sink.claim!("c4", 5_000, 1_000), true, "released → claimable at once");
});

test("claiming does NOT settle: the leg is still pending until markSettled", async () => {
  // The crash scenario, stated as an invariant. A claim means "an attempt is in flight", never
  // "the money moved" — conflating them would mark unpaid legs settled, which is far worse than
  // the defect being fixed.
  const sink = memoryPendingLegSink([leg("c5")]);
  await sink.claim!("c5", 5_000, 1_000);
  assert.deepEqual((await sink.pending(1_000)).map((l) => l.id), ["c5"], "claimed ≠ settled");
  assert.equal(await sink.markSettled("c5", "ref"), true, "the claim holder can still settle it");
});
