import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc, walletAddress, type AttributedEvent, type AuthorShare } from "@naulon/shared";
import { aggregate } from "./aggregate.ts";

const W1 = walletAddress("0x1111111111111111111111111111111111111111");
const W2 = walletAddress("0x2222222222222222222222222222222222222222");
const PAYER = walletAddress("0x9999999999999999999999999999999999999999");

function event(
  id: string,
  amount: number,
  payees: AuthorShare[],
  at: number,
): AttributedEvent {
  return {
    id,
    slug: `slug-${id}`,
    kind: "citation",
    amount: usdc(amount),
    payees,
    payerAddress: PAYER,
    settlementRef: `ref-${id}`,
    at,
  };
}

test("sums total settled across all events", () => {
  const led = aggregate([
    event("a", 0.01, [{ authorId: "alice", wallet: W1, share: 1 }], 1),
    event("b", 0.02, [{ authorId: "alice", wallet: W1, share: 1 }], 2),
  ]);
  assert.equal(led.totalSettled, 0.03);
  assert.equal(led.eventCount, 2);
});

test("splits an event's amount by each payee's share", () => {
  const led = aggregate([
    event("a", 0.01, [
      { authorId: "alice", wallet: W1, share: 0.75 },
      { authorId: "bob", wallet: W2, share: 0.25 },
    ], 1),
  ]);
  const alice = led.authors.find((r) => r.wallet === W1);
  const bob = led.authors.find((r) => r.wallet === W2);
  assert.equal(alice?.earned, 0.0075);
  assert.equal(bob?.earned, 0.0025);
  assert.equal(led.authorCount, 2);
});

test("accrues a wallet's earnings across events and tracks last-seen + count", () => {
  const led = aggregate([
    event("a", 0.01, [{ authorId: "alice", wallet: W1, share: 1 }], 10),
    event("b", 0.03, [{ authorId: "alice", wallet: W1, share: 1 }], 5),
  ]);
  assert.equal(led.authors.length, 1);
  const alice = led.authors[0];
  assert.equal(alice?.earned, 0.04);
  assert.equal(alice?.events, 2);
  assert.equal(alice?.lastAt, 10, "lastAt is the max event time, not the latest-recorded");
});

test("sorts authors by earnings, descending", () => {
  const led = aggregate([
    event("a", 0.01, [{ authorId: "alice", wallet: W1, share: 1 }], 1),
    event("b", 0.05, [{ authorId: "bob", wallet: W2, share: 1 }], 2),
  ]);
  assert.deepEqual(led.authors.map((r) => r.authorId), ["bob", "alice"]);
});

test("recent feed is newest-first and capped at recentLimit", () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    event(String(i), 0.01, [{ authorId: "alice", wallet: W1, share: 1 }], i),
  );
  const led = aggregate(events, 3);
  assert.equal(led.recent.length, 3);
  assert.deepEqual(led.recent.map((c) => c.at), [4, 3, 2]);
});

test("recent crossing carries the per-author split amounts", () => {
  const led = aggregate([
    event("a", 0.01, [
      { authorId: "alice", wallet: W1, share: 0.6 },
      { authorId: "bob", wallet: W2, share: 0.4 },
    ], 1),
  ]);
  assert.deepEqual(led.recent[0]?.split, [
    { authorId: "alice", amount: 0.006 },
    { authorId: "bob", amount: 0.004 },
  ]);
});

test("empty ledger is a zeroed, valid shape", () => {
  const led = aggregate([]);
  assert.deepEqual(led, {
    totalSettled: 0,
    eventCount: 0,
    authorCount: 0,
    authors: [],
    recent: [],
  });
});
