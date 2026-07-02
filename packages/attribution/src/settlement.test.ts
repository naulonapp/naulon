import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfig } from "@naulon/shared";
import { getSettlement, mockSettlement } from "./settlement.ts";
import type { Payout } from "./batch.ts";

function payout(authorId: string, amountUsdc: number, eventIds: string[]): Payout {
  return { authorId, wallet: `0x${authorId.padEnd(40, "0")}`, amountUsdc, eventIds };
}

test("mock settlement returns one receipt per payout, preserving fields", async () => {
  const payouts = [
    payout("alice", 0.01, ["e1", "e2"]),
    payout("bob", 0.02, ["e3"]),
  ];
  const receipts = await mockSettlement().settle(payouts, 1700);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0]?.authorId, "alice");
  assert.equal(receipts[0]?.amountUsdc, 0.01);
  assert.deepEqual(receipts[0]?.eventIds, ["e1", "e2"]);
  assert.equal(receipts[0]?.at, 1700);
});

test("mock refs are deterministic in (now, index) — distinct per payout", async () => {
  const receipts = await mockSettlement().settle(
    [payout("alice", 0.01, ["e1"]), payout("bob", 0.02, ["e2"])],
    42,
  );
  assert.equal(receipts[0]?.ref, "mock-payout-42-0");
  assert.equal(receipts[1]?.ref, "mock-payout-42-1");
});

test("no payouts settle to no receipts", async () => {
  assert.deepEqual(await mockSettlement().settle([], 1), []);
});

test("getSettlement returns the mock path when no Circle key is set", () => {
  const had = process.env.CIRCLE_API_KEY;
  delete process.env.CIRCLE_API_KEY;
  resetConfig();
  try {
    assert.doesNotThrow(() => getSettlement());
  } finally {
    if (had !== undefined) process.env.CIRCLE_API_KEY = had;
    resetConfig();
  }
});

test("getSettlement fails loud rather than mock-settling real money with a key set", () => {
  const had = process.env.CIRCLE_API_KEY;
  process.env.CIRCLE_API_KEY = "test-key-not-real";
  resetConfig();
  try {
    assert.throws(() => getSettlement(), /offline simulation|custody/);
  } finally {
    if (had === undefined) delete process.env.CIRCLE_API_KEY;
    else process.env.CIRCLE_API_KEY = had;
    resetConfig();
  }
});
