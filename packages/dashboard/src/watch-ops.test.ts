import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservationEvent } from "@naulon/shared";
import { watchOps } from "./watch-ops.ts";

const NOW = 1_800_000_000_000;
const noSleep = async (): Promise<void> => {};
const now = () => NOW;

let seq = 0;
const obs = (at: number): ObservationEvent => ({
  id: `o${++seq}`,
  host: "example.test",
  slug: "s",
  verdict: "denied",
  classifiedAs: "agent",
  at,
});

/** Drain up to `max` snapshots, then stop the loop — the generator never ends on its own. */
async function take(
  read: () => Promise<ObservationEvent[]>,
  max: number,
  signal = { aborted: false },
): Promise<number[]> {
  const out: number[] = [];
  for await (const snap of watchOps(read, { signal, sleep: noSleep, now })) {
    out.push(snap.total);
    if (out.length >= max) signal.aborted = true;
  }
  return out;
}

test("yields an initial snapshot, then again only when the log changes", async () => {
  let rows = [obs(NOW)];
  let reads = 0;
  const read = async () => {
    reads += 1;
    if (reads === 4) rows = [...rows, obs(NOW)];
    return rows;
  };
  const seen = await take(read, 2);
  assert.deepEqual(seen, [1, 2], "the identical reads in between pushed nothing");
});

test("a truncated log is a change, even when the count coincides", async () => {
  // Rotation is real: a jsonl log can be replaced by a shorter one, or by a same-length
  // one with different rows. Keying on count alone would sit silent through it.
  const first = [obs(NOW), obs(NOW - 1)];
  const rotated = [obs(NOW + 5_000), obs(NOW + 5_001)];
  let reads = 0;
  const read = async () => (++reads <= 2 ? first : rotated);
  const seen = await take(read, 2);
  assert.equal(seen.length, 2, "the same-length rotation still pushed");
});

test("an already-aborted signal yields nothing", async () => {
  let reads = 0;
  const seen = await take(
    async () => {
      reads += 1;
      return [obs(NOW)];
    },
    5,
    { aborted: true },
  );
  assert.deepEqual(seen, []);
  assert.equal(reads, 0, "and it never even read the log");
});

test("the window is applied to the snapshot, so an old row is not counted as live traffic", async () => {
  const rows = [obs(NOW), obs(NOW - 10 * 3_600_000)];
  const signal = { aborted: false };
  const out: number[] = [];
  for await (const snap of watchOps(async () => rows, { signal, sleep: noSleep, now, windowMs: 3_600_000 })) {
    out.push(snap.total);
    signal.aborted = true;
  }
  assert.deepEqual(out, [1], "the 10-hour-old row is outside a 1h window");
});
