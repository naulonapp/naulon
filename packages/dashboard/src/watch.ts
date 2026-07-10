/**
 * watchLedger — the live source behind /api/stream, pulled out of the route so
 * it can be unit-tested without an HTTP server or a real clock.
 *
 * It yields a ledger snapshot immediately, then again every time the ledger
 * changes. "Changed" is keyed on (eventCount, totalSettled), so a same-count
 * mutation — an amount correction, a re-settle — still pushes, which the old
 * bare `events.length` check silently missed. The clock (`sleep`) and the
 * stop-signal are injected, keeping the loop deterministic in tests.
 */
import type { EventSink } from "@naulon/shared";
import { aggregate, type Ledger } from "./aggregate.ts";
import { POLL_MS, RECENT_LIMIT } from "./constants.ts";

export interface WatchOptions {
  /** Poll interval in ms. Defaults to POLL_MS. */
  pollMs?: number;
  /** Cooperative stop flag — set `.aborted = true` to end the loop. */
  signal?: { aborted: boolean };
  /** Injectable delay; defaults to setTimeout. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const changeKey = (l: Ledger): string => `${l.eventCount}:${l.totalSettled}`;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function* watchLedger(
  sink: EventSink,
  opts: WatchOptions = {},
): AsyncGenerator<Ledger> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const signal = opts.signal;
  let last = "";

  while (!signal?.aborted) {
    const led = aggregate(await sink.readAll(), RECENT_LIMIT);
    const key = changeKey(led);
    if (key !== last) {
      last = key;
      yield led;
    }
    if (signal?.aborted) break; // the consumer may have aborted during the yield
    await sleep(pollMs);
  }
}
