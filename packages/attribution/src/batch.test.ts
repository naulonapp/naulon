import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc, walletAddress, type AttributedEvent, type AuthorShare } from "@naulon/shared";
import { batchCuts, batchPayouts, expandCuts } from "./batch.ts";

const W1 = walletAddress("0x1111111111111111111111111111111111111111");
const W2 = walletAddress("0x2222222222222222222222222222222222222222");

function event(id: string, amount: number, payees: AuthorShare[]): AttributedEvent {
  return {
    id,
    slug: "s",
    kind: "citation",
    amount: usdc(amount),
    payees,
    payerAddress: walletAddress("0x9999999999999999999999999999999999999999"),
    settlementRef: "r",
    at: 0,
  };
}

const solo = (w: typeof W1, id: string): AuthorShare[] => [{ authorId: id, wallet: w, share: 1 }];

test("accrues many small events into one payout per wallet", () => {
  const events = [
    event("e1", 0.001, solo(W1, "a")),
    event("e2", 0.001, solo(W1, "a")),
    event("e3", 0.001, solo(W1, "a")),
    event("e4", 0.001, solo(W1, "a")),
    event("e5", 0.001, solo(W1, "a")),
  ];
  const { payouts } = batchPayouts(events, 0.005);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amountUsdc, 0.005);
  assert.deepEqual(payouts[0]!.eventIds, ["e1", "e2", "e3", "e4", "e5"]);
});

test("defers wallets below the minimum", () => {
  const { payouts, deferred } = batchPayouts([event("e1", 0.001, solo(W1, "a"))], 0.005);
  assert.equal(payouts.length, 0);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0]!.amountUsdc, 0.001);
});

test("splits a co-authored event across wallets, conserving the total", () => {
  const payees: AuthorShare[] = [
    { authorId: "a", wallet: W1, share: 2 / 3 },
    { authorId: "b", wallet: W2, share: 1 / 3 },
  ];
  // 6 citations @ 0.005 = 0.03 total; ~2:1 split. The dust remainder lands on
  // the larger share each event, so W1 is a few micro above a clean 0.02 —
  // intended; the invariant is that the total is conserved exactly.
  const events = Array.from({ length: 6 }, (_, i) => event(`e${i}`, 0.005, payees));
  const { payouts } = batchPayouts(events, 0.005);
  const total = payouts.reduce((s, p) => s + p.amountUsdc, 0);
  assert.ok(Math.abs(total - 0.03) < 1e-9, `total ${total}`);
  const w1 = payouts.find((p) => p.wallet === W1)!;
  const w2 = payouts.find((p) => p.wallet === W2)!;
  assert.ok(w1.amountUsdc > w2.amountUsdc, "larger share earns more");
  assert.ok(Math.abs(w1.amountUsdc - 0.02) < 1e-5, `w1 ${w1.amountUsdc}`);
  assert.ok(Math.abs(w2.amountUsdc - 0.01) < 1e-5, `w2 ${w2.amountUsdc}`);
});

test("a deferred co-author cut survives once its co-author is paid (per-cut settlement)", () => {
  // One event: W1 huge share clears the floor, W2 tiny share does not.
  const payees: AuthorShare[] = [
    { authorId: "a", wallet: W1, share: 0.99 },
    { authorId: "b", wallet: W2, share: 0.01 },
  ];
  const cuts = expandCuts([event("e1", 0.01, payees)]);
  const { payouts, deferred } = batchCuts(cuts, 0.005);
  assert.deepEqual(payouts.map((p) => p.wallet), [W1]);
  assert.deepEqual(deferred.map((p) => p.wallet), [W2]);

  // Next pass: W1's cut is settled, W2's is not — so only W2's cut remains, and
  // it accrues again rather than being lost.
  const settled = new Set([`e1:${W1}`]);
  const remaining = cuts.filter((c) => !settled.has(`${c.eventId}:${c.wallet}`));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.wallet, W2);
});
