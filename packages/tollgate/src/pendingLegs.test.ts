/**
 * PendingLegSink (memory backend) unit tests — the deferred-extra-leg store behind O5/O1.
 * The branchy parts that must be exactly right: idempotent record (a buyer retry can't
 * duplicate a leg), the pending filter (settled + expired + publisher scope), and the
 * atomic markSettled (settle exactly once across concurrent drains).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryPendingLegSink, outstandingLegMicro, type PendingLeg } from "./pendingLegs.ts";

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

test("claiming does NOT settle: the leg is still OWED until markSettled", async () => {
  // The crash scenario, stated as an invariant. A claim means "an attempt is in flight", never
  // "the money moved" — conflating them would mark unpaid legs settled, which is far worse than
  // the defect being fixed.
  //
  // Asserted through `outstanding`, not `pending`. `pending` answers "what may I broadcast now" and
  // correctly hides a leased leg; `outstanding` answers "what is still owed" and must not. This
  // test used to make the claim through `pending` — which was only possible because the memory sink
  // ignored the lease while the production sink filters on it, so the two backends disagreed and a
  // green test said nothing about prod.
  const sink = memoryPendingLegSink([leg("c5")]);
  await sink.claim!("c5", 5_000, 1_000);
  assert.deepEqual((await sink.pending(1_000)).map((l) => l.id), [], "a leased leg is not re-broadcastable");
  assert.deepEqual((await sink.outstanding!(1_000)).map((l) => l.id), ["c5"], "but it is still owed — claimed ≠ settled");
  assert.equal(await sink.markSettled("c5", "ref"), true, "the claim holder can still settle it");
  assert.deepEqual((await sink.outstanding!(1_000)).map((l) => l.id), [], "and settling is what clears it");
});

test("the memory sink honours the claim lease exactly as the production sink does", async () => {
  // The divergence itself, pinned. It is the reason a guard built on `pending` looked correct in
  // every test and would have been wrong in prod.
  const sink = memoryPendingLegSink([leg("c6")]);
  await sink.claim!("c6", 5_000, 1_000);
  assert.deepEqual((await sink.pending(1_000)).map((l) => l.id), [], "inside the lease: hidden");
  assert.deepEqual((await sink.pending(9_000)).map((l) => l.id), ["c6"], "past it: claimable again");
});

/* ── outstandingLegMicro: what a buyer's balance already owes the drain ───────────────────────── */

/** A pending leg as `deferExtraLegs` records one — the payer lives inside the signed payload. */
function legFor(id: string, payer: string | null, amount: string, validBefore: number): PendingLeg {
  return {
    id,
    role: "operator",
    payTo: "0x" + "f".repeat(40),
    amount,
    payload: payer === null ? {} : { payload: { authorization: { from: payer } } },
    requirements: {} as never,
    validBefore,
    at: 1,
  };
}

const BUYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

test("outstandingLegMicro totals only THIS buyer's unsettled legs", async () => {
  const sink = memoryPendingLegSink([
    legFor("a", BUYER, "60000", 9_000),
    legFor("b", BUYER, "40000", 9_000),
    legFor("c", OTHER, "999000", 9_000),
  ]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 100_000);
  assert.equal(await outstandingLegMicro(OTHER, 1_000, { sink }), 999_000);
});

test("a SETTLED leg stops counting the moment the drain takes it", async () => {
  // The reason this reads the drain's own sink instead of a second tally: there is nothing to
  // reconcile. Settling is the only thing that has to happen for the buyer's headroom to return.
  const sink = memoryPendingLegSink([legFor("a", BUYER, "60000", 9_000), legFor("b", BUYER, "40000", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 100_000);
  await sink.markSettled("a", "0xref");
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 40_000, "a settled leg is no longer owed");
});

test("an EXPIRED leg stops counting — it can never be burned again", async () => {
  // Past `validBefore` the authorization is dead: the buyer cannot be charged for it, so it must
  // not keep holding their balance hostage either.
  const sink = memoryPendingLegSink([legFor("a", BUYER, "60000", 500)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 0);
});

test("a leg whose payer cannot be read counts against EVERYONE, never nobody", async () => {
  // It is money owed by somebody. The failure being guarded is spending a balance that is already
  // promised, so an unreadable leg must make the guard stricter — dropping it is the direction that
  // loses the money.
  const sink = memoryPendingLegSink([legFor("a", null, "60000", 9_000), legFor("b", BUYER, "10000", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 70_000);
  assert.equal(await outstandingLegMicro(OTHER, 1_000, { sink }), 60_000, "and against a buyer with no legs of their own");
});

test("payer matching is case-insensitive — a checksummed address is the same buyer", async () => {
  const sink = memoryPendingLegSink([legFor("a", BUYER.toUpperCase().replace("0X", "0x"), "60000", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 60_000);
});

test("an unparseable amount is treated as unspendable, not as zero", async () => {
  const sink = memoryPendingLegSink([legFor("a", BUYER, "not-a-number", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), Number.MAX_SAFE_INTEGER);
});

test("a CLAIMED leg still counts as owed — the P0 that `pending` would have hidden", async () => {
  // `drainPendingLegs` claims a leg BEFORE broadcasting and, on a failed or unknown-outcome
  // attempt, deliberately does not release — so the leg stays claimed for a full lease while its
  // money is still entirely present in the buyer's balance. Reading `pending` here would report 0
  // owed for that whole window and let the buyer spend it, which is precisely the loss this
  // function exists to prevent, reintroduced through a filter meant for a different question.
  const sink = memoryPendingLegSink([legFor("a", BUYER, "400000", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 400_000);
  assert.equal(await sink.claim!("a", 5_000, 1_000), true, "a drain takes the leg");
  assert.deepEqual(await sink.pending(1_000), [], "pending hides it — correctly, for ITS question");
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 400_000, "but it is still owed");
});

test("a sink that cannot answer REFUSES — it never falls back to pending", async () => {
  // A fallback to `pending` would be the defect above wearing the shape of a graceful degradation.
  const crippled = { pending: async () => [] } as unknown as NonNullable<Parameters<typeof outstandingLegMicro>[2]>["sink"];
  await assert.rejects(
    () => outstandingLegMicro(BUYER, 1_000, { sink: crippled }),
    /implements no outstanding/,
  );
});

test("legs on ANOTHER chain do not count against this chain's balance", async () => {
  // A Gateway balance is per (depositor, domain). Counting every chain's legs against one chain's
  // `available` refuses a buyer whose money is on the chain being paid, and names the wrong pot.
  const here = { ...legFor("a", BUYER, "400000", 9_000), requirements: { network: "eip155:8453" } as never };
  const elsewhere = { ...legFor("b", BUYER, "900000", 9_000), requirements: { network: "eip155:5042002" } as never };
  const sink = memoryPendingLegSink([here, elsewhere]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 1_300_000, "unscoped counts both");
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink, network: "eip155:8453" }), 400_000);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink, network: "eip155:5042002" }), 900_000);
});

test("a leg with no network recorded counts everywhere — unattributable is never dropped", async () => {
  const sink = memoryPendingLegSink([legFor("a", BUYER, "400000", 9_000)]); // requirements: {} 
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink, network: "eip155:8453" }), 400_000);
});

test("the caller's OWN legs are excludable, so a replay is not refused for money it does not need", async () => {
  // Re-presenting an identical authorization is a replay the reserve absorbs and which needs no new
  // money. Counting the retry's own recorded legs against it refuses a payment that already happened.
  const sink = memoryPendingLegSink([legFor("a", BUYER, "400000", 9_000), legFor("b", BUYER, "60000", 9_000)]);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink }), 460_000);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink, exclude: ["a"] }), 60_000);
  assert.equal(await outstandingLegMicro(BUYER, 1_000, { sink, exclude: ["a", "b"] }), 0);
});
