/**
 * watchOps — the live source behind /api/stream/ops. The Overview polled for traffic
 * while the ledger streamed, so the two halves of the same screen moved on different
 * clocks and the request feed lagged the money by up to the poll interval.
 *
 * Deliberately the same shape as `watchLedger`: yield a snapshot immediately, then
 * again only when something changed, with the clock and the stop-signal injected so
 * the loop is deterministic in tests. Change is keyed on the observation COUNT plus
 * the newest timestamp — count alone misses a log that was rotated or truncated to
 * the same length, and `at` alone misses two events landing in one millisecond.
 */
import type { ObservationEvent } from "@naulon/shared";
import { summarizeOps, type OpsSummary } from "./ops.ts";
import { POLL_MS } from "./constants.ts";

export interface WatchOpsOptions {
  /** Poll interval in ms. Defaults to POLL_MS. */
  pollMs?: number;
  /** Cooperative stop flag — set `.aborted = true` to end the loop. */
  signal?: { aborted: boolean };
  /** Injectable delay; defaults to setTimeout. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, so the window cutoff is deterministic under test. */
  now?: () => number;
  /** Traffic window in ms. */
  windowMs?: number;
}

const changeKey = (observations: readonly ObservationEvent[]): string => {
  let newest = 0;
  for (const o of observations) if (o.at > newest) newest = o.at;
  return `${observations.length}:${newest}`;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function* watchOps(
  read: () => Promise<ObservationEvent[]>,
  opts: WatchOpsOptions = {},
): AsyncGenerator<OpsSummary> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const signal = opts.signal;
  let last = "";

  while (!signal?.aborted) {
    const observations = await read();
    const key = changeKey(observations);
    if (key !== last) {
      last = key;
      yield summarizeOps(observations, now(), opts.windowMs);
    }
    if (signal?.aborted) break; // the consumer may have aborted during the yield
    await sleep(pollMs);
  }
}
