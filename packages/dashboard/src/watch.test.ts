import assert from "node:assert/strict";
import { test } from "node:test";
import {
  usdc,
  walletAddress,
  type AttributedEvent,
  type EventSink,
} from "@naulon/shared";
import { watchLedger } from "./watch.ts";

const W = walletAddress("0x1111111111111111111111111111111111111111");
const PAYER = walletAddress("0x9999999999999999999999999999999999999999");

const ev = (id: string, amount: number): AttributedEvent => ({
  id,
  slug: `slug-${id}`,
  kind: "read",
  amount: usdc(amount),
  payees: [{ authorId: "ava", wallet: W, share: 1 }],
  payerAddress: PAYER,
  settlementRef: `ref-${id}`,
  at: 1,
});

/** A sink that returns a scripted sequence of ledgers, one per readAll (last frame sticks). */
function scriptedSink(frames: AttributedEvent[][]): EventSink {
  let i = 0;
  return {
    async readAll() {
      const frame = frames[Math.min(i, frames.length - 1)]!;
      i += 1;
      return [...frame];
    },
    async record() {},
    async get() {
      return undefined;
    },
  };
}

/**
 * A no-delay clock that aborts once `reads` reads have happened. The loop reads,
 * (maybe) yields, then sleeps — so aborting on the Nth sleep lets exactly N
 * reads run before the next while-check exits.
 */
function clock(signal: { aborted: boolean }, reads: number) {
  let sleeps = 0;
  return async () => {
    sleeps += 1;
    if (sleeps >= reads) signal.aborted = true;
  };
}

test("yields an initial snapshot, then again only when the ledger changes", async () => {
  const sink = scriptedSink([[ev("a", 0.01)], [ev("a", 0.01), ev("b", 0.02)]]);
  const signal = { aborted: false };

  const counts: number[] = [];
  for await (const led of watchLedger(sink, { signal, sleep: clock(signal, 3), pollMs: 0 })) {
    counts.push(led.eventCount);
  }

  // 1: initial · 2: after the new crossing · 3rd read is the same frame → no yield.
  assert.deepEqual(counts, [1, 2]);
});

test("detects a same-count mutation via total, not just length", async () => {
  const sink = scriptedSink([[ev("a", 0.01)], [ev("a", 0.05)]]);
  const signal = { aborted: false };

  const totals: number[] = [];
  for await (const led of watchLedger(sink, { signal, sleep: clock(signal, 2), pollMs: 0 })) {
    totals.push(led.totalSettled);
  }

  // Count stays 1 both frames; a length-only check would miss the second push.
  assert.deepEqual(totals, [0.01, 0.05]);
});

test("an already-aborted signal yields nothing", async () => {
  const sink = scriptedSink([[ev("a", 0.01)]]);
  const out: unknown[] = [];
  for await (const led of watchLedger(sink, { signal: { aborted: true }, sleep: async () => {} })) {
    out.push(led);
  }
  assert.equal(out.length, 0);
});
