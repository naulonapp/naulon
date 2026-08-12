// packages/tollgate/src/webhookSink.ts — the self-host webhook emit, wire #4. The OSS counterpart to
// cloud's server-side dispatch: a lazy module-level singleton builds the core dispatch over an
// EnvConfigStore (NAULON_WEBHOOK_ENDPOINTS) + the in-memory delivery store + the HTTP sender. Dark by
// default — no endpoints ⇒ no singleton, no timer, no POST.
//
// It ran ALONGSIDE the origin-mirror (settlementSink.ts) through P2. WH-1 P3 deleted the mirror, so
// this is now the ONLY settlement-notification path the gate has.

import { getConfig, parseWebhookEndpointsEnv, type AttributedEvent } from "@naulon/shared";
import {
  HttpWebhookSender,
  JsonlWebhookDeliveryStore,
  makeDispatchEvent,
  sweepWebhookDeliveries,
  type DispatchDeps,
  type WebhookEvent,
} from "@naulon/shared";
import { EnvConfigStore } from "./webhookEnvStore.ts";

interface Sink {
  dispatch: (e: WebhookEvent) => Promise<void>;
  deps: DispatchDeps;
}

let sink: Sink | null | undefined; // undefined = not built; null = built-and-dark
let testFetch: typeof fetch | undefined; // injected in tests so the sender's fetch path is stubbable

function build(): Sink | null {
  const specs = parseWebhookEndpointsEnv(getConfig().NAULON_WEBHOOK_ENDPOINTS);
  if (specs.length === 0) return null; // dark
  const deps: DispatchDeps = {
    endpoints: new EnvConfigStore(specs),
    // A JSONL journal, not process memory. Memory dropped every unsent delivery on restart — a
    // settlement notification the operator is owed — and was invisible to the dashboard, which is a
    // separate process and can only see gate state through a file.
    deliveries: new JsonlWebhookDeliveryStore({ path: () => getConfig().WEBHOOK_DELIVERIES_PATH }),
    // Self-host endpoints come from the operator's own env (trusted) and may point at an internal
    // service, so private targets are allowed here — unlike cloud, where endpoints are tenant-supplied
    // and the SSRF guard must stay on. (https is still required — the sender rejects cleartext.)
    sender: new HttpWebhookSender({ timeoutMs: 10_000, allowPrivateTargets: true, fetchImpl: testFetch }),
    autoDisableThreshold: 20,
    concurrency: 5,
  };
  return { dispatch: makeDispatchEvent(deps), deps };
}

function getSink(): Sink | null {
  if (sink === undefined) sink = build();
  return sink;
}

/** µUSDC integer from a whole-USDC branded amount — never a float divide. */
function amountMicro(amount: AttributedEvent["amount"]): number {
  return Math.round(Number(amount) * 1_000_000);
}

/**
 * Enqueues that have not finished writing. `settle.ts` fires the emit with `void` — deliberately,
 * so a webhook never delays a settle — and the enqueue now touches the filesystem rather than a Map,
 * which takes long enough that a sweep started immediately afterwards can beat it to the journal.
 *
 * In production that is a non-event: the sweep runs on a timer and the delivery is picked up on the
 * next tick. It only matters where something settles and sweeps in the same breath, which is a test
 * (and a serverless cron, where the next cron tick would cover it anyway).
 */
const inFlight = new Set<Promise<unknown>>();

/**
 * Enqueue a `settlement.completed` webhook for the settled event. Never throws (settle already
 * happened + the agent holds its receipt); dark-safe (no-op with no endpoints). The sweep does the
 * actual HTTP out of band, so this never delays the settle path.
 */
export async function emitSettlementWebhook(event: AttributedEvent, host: string | null): Promise<void> {
  const s = getSink();
  if (!s) return;
  const wh: WebhookEvent = {
    ownerUserId: "self-host",
    host,
    type: "settlement.completed",
    eventId: event.id, // dedup key = the settle event id (= license jti)
    payload: {
      host,
      publisherId: event.publisherId,
      eventId: event.id,
      slug: event.slug,
      kind: event.kind,
      amountMicro: amountMicro(event.amount),
      settlementRef: event.settlementRef,
      chainId: event.chainId,
      at: event.at,
    },
  };
  const enqueue = s.dispatch(wh).catch((err: unknown) => {
    console.error("[tollgate] webhook enqueue failed (settlement already on-chain):", err);
  });
  inFlight.add(enqueue);
  try {
    await enqueue;
  } finally {
    inFlight.delete(enqueue);
  }
}

/** Wait for every in-flight enqueue to reach the journal. See the `inFlight` note above. */
export async function flushWebhookEnqueues(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * Run one sweep now (boot recovery / test / serverless cron). No-op when dark.
 *
 * Flushes pending enqueues first, so "settle, then sweep" sends the delivery that settle just
 * produced rather than racing it.
 */
export async function sweepOnceForTest(): Promise<void> {
  const s = getSink();
  if (!s) return;
  await flushWebhookEnqueues();
  await sweepWebhookDeliveries(s.deps);
}

/**
 * Start the background sweep: one boot sweep (recover anything a restart stranded), then on
 * WEBHOOK_SWEEP_INTERVAL_MS. No-op when dark or interval 0 (serverless drives the sweep via cron).
 */
export function startWebhookSweep(): { stop: () => void } {
  const s = getSink();
  if (!s) return { stop: () => {} };
  const interval = getConfig().WEBHOOK_SWEEP_INTERVAL_MS;
  const run = (): void => {
    void sweepWebhookDeliveries(s.deps).catch((err: unknown) =>
      console.error("[tollgate] webhook sweep failed:", err),
    );
  };
  run(); // boot recovery
  if (interval === 0) return { stop: () => {} };
  const timer = setInterval(run, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Test seam: drop the singleton so the next call re-reads env (pair with resetConfig()). */
export function resetWebhookSinkForTest(): void {
  sink = undefined;
}

/** Test seam: inject a fetch stub for the sender (https targets still required by guardTarget), and
 *  drop the singleton so the next build picks it up. Pass undefined to restore the real fetch path. */
export function setWebhookFetchForTest(f: typeof fetch | undefined): void {
  testFetch = f;
  sink = undefined;
}
