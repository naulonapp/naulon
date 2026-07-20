/**
 * Wire #3, producer side: report a settled toll to the publisher's earnings
 * ledger. POST ${ORIGIN_URL}/api/credits/settlement, HMAC-signed.
 *
 * Delivery is crash-safe at-least-once, with durability decoupled from the
 * request hot path:
 *
 *   - HOT PATH (emitSettlement, called from app.ts after a paid read): ONE timed
 *     attempt. Success → mark acked. Failure → leave it; the drain owns retries.
 *     The agent already paid and holds its receipt, so this never throws and
 *     never blocks the response on a retry chain — one bounded fetch, that's it.
 *
 *   - DRAIN (drainSettlements, run on boot + on an interval): the at-least-once
 *     engine. Asks the SettlementDeliveryStore for the events that are DUE — never
 *     the whole ledger — and re-sends each with a bounded, re-signed, backed-off
 *     retry, persisting the outcome so the next sweep knows what happened.
 *
 * Delivery STATE (acked / attempts / next attempt / dead-letter) lives in
 * settlementDelivery.ts, keyed by event id, deliberately separate from the
 * append-only settlement ledger: the ledger records that money MOVED and must never
 * be mutated; whether we have successfully REPORTED it is a different lifecycle.
 * Retry is bounded and ends in a dead letter that is parked and visible — never an
 * age cutoff, because silently abandoning owed money is worse than retrying.
 *
 * Idempotent on IA's side by eventId (= event.id), so a duplicate is a no-op
 * ({"deduped":true}) — losing local state can only cost a redundant POST, never
 * an earnings record. Dark by default: with no CREDITS_SETTLEMENT_SECRET, every
 * entry point is a no-op, so the offline mock loop runs creds-free (hard rule).
 */
import {
  activeNetwork,
  buildSettlementBody,
  getConfig,
  signSettlement,
  type AttributedEvent,
} from "@naulon/shared";
import { getSettlementDeliveryStore } from "./settlementDelivery.ts";

/** Classify the origin's response so the retry loop knows whether to try again. */
type Outcome =
  | { ok: true } // 2xx — stored or deduped
  | { ok: false; retry: false; reason: string } // permanent (400) — don't hammer
  | { ok: false; retry: true; status?: number; reason: string }; // transient (network/5xx/401/404-dark)

/** One signed POST attempt, timestamped fresh (IA rejects clock skew > 300s). */
async function attempt(event: AttributedEvent, secret: string, originUrl: string): Promise<Outcome> {
  const cfg = getConfig();
  const target = new URL("/api/credits/settlement", originUrl);
  // The event's own settle chain when stamped (per-tenant), else the fleet default
  // — so a re-send on any path reports the chain the money actually moved on.
  const chainId = event.chainId ?? activeNetwork().chainId;
  const body = JSON.stringify(buildSettlementBody(event, chainId, cfg.PRIMARY_PAYEE_TIEBREAK));
  const { timestamp, signature } = signSettlement(body, secret, Math.floor(Date.now() / 1000));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.SETTLEMENT_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Naulon-Timestamp": timestamp,
        "X-Naulon-Signature": signature,
      },
      body, // the SAME string that was signed
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true }; // 200 stored or deduped
    if (res.status === 400) return { ok: false, retry: false, reason: "400 malformed payload" };
    // 401 (clock/secret), 404 (credits_api flag dark), 5xx → transient. The status rides along so
    // `deliver` can tell a repeated 401 (a wrong secret — see below) from a genuinely flaky origin.
    return { ok: false, retry: true, status: res.status, reason: String(res.status) };
  } catch (err) {
    return { ok: false, retry: true, reason: `network: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver one event with a bounded, re-signed, backed-off retry WITHIN this sweep.
 * Returns ok once the publisher has acked it, or the reason it didn't. Recording the
 * outcome is the caller's job (the delivery store owns ack/attempt/dead-letter state);
 * the hot path uses a single `attempt` instead so it never stalls the response.
 */
async function deliver(
  event: AttributedEvent,
  secret: string,
  originUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const max = getConfig().SETTLEMENT_MAX_ATTEMPTS;
  for (let i = 0; i < max; i++) {
    const out = await attempt(event, secret, originUrl);
    if (out.ok) return { ok: true };
    if (!out.retry) {
      console.error(`[tollgate] settlement ${event.id} permanently rejected (${out.reason})`);
      // A 400 won't fix itself — stop, don't burn this sweep's budget. It still counts
      // as a failed sweep, so the cross-sweep ladder eventually dead-letters it and an
      // operator sees a permanently-malformed payload instead of it churning silently.
      return { ok: false, error: `permanent: ${out.reason}` };
    }
    // A 401 means clock skew OR a wrong secret, and only the first is transient. Every `attempt`
    // re-signs with a FRESH timestamp, so a second consecutive 401 rules clock skew out: the
    // secret is wrong. Keep burning the ladder and every later sweep hides a config error behind
    // what looks like a flaky origin — so stop and say which one it is.
    if (out.status === 401 && i > 0) {
      console.error(
        `[tollgate] settlement ${event.id}: repeated 401 after a re-signed attempt — the ` +
          `settlement secret is almost certainly wrong (rotated on one side only), not clock skew. ` +
          `The event stays unacked and will be retried; fix the secret.`,
      );
      return { ok: false, error: "repeated 401 — settlement secret is almost certainly wrong" };
    }
    if (i < max - 1) await sleep(250 * 2 ** i); // 250ms, 500, 1s, 2s…
  }
  return { ok: false, error: "attempt budget exhausted (origin unreachable or erroring)" };
}

/**
 * Hot-path emit: one fast, timed attempt after a paid read. Never throws. On
 * failure the event stays unacked and the drain re-sends it out of band.
 *
 * The secret + origin come from the resolved publisher's config (not global
 * config), so the emit reports earnings to that publisher with its own secret. An
 * undefined secret leaves the emit dark (no creds, no report) — the no-creds mock
 * loop relies on this.
 */
export async function emitSettlement(
  event: AttributedEvent,
  secret: string | undefined,
  originUrl: string,
): Promise<void> {
  if (!secret) return; // dark — no creds, no emit
  const store = getSettlementDeliveryStore();
  if (await store.isAcked(event.id)) return; // already confirmed (e.g. drain beat us)

  const out = await attempt(event, secret, originUrl);
  if (out.ok) await store.markAcked(event.id, event.publisherId, Date.now());
  // A miss is expected and fine — the drain guarantees eventual delivery. We deliberately
  // do NOT record a failed attempt here: the hot path's single try is opportunistic, and
  // charging it against the cross-sweep budget would dead-letter an event that the drain
  // has not actually given up on yet.
}

/**
 * Optional overrides for a drain sweep — the embedding seam. A downstream service
 * that fronts a chosen publisher passes that publisher's secret + origin (and an
 * optional `publisherId` to restrict the sweep to its events) so settlements re-sign
 * and re-POST with the right credentials. Omitted entirely → single-tenant
 * behaviour, reading the one settlement secret + origin off global config (the
 * live loop's path, unchanged).
 */
export interface DrainScope {
  /** Settlement HMAC secret to sign with. Falls back to CREDITS_SETTLEMENT_SECRET. */
  secret?: string;
  /** Publisher origin to POST settlements to. Falls back to ORIGIN_URL. */
  originUrl?: string;
  /** Restrict the sweep to one publisher's events. Omitted → the whole ledger. */
  publisherId?: string;
}

/**
 * Sweep the DUE settlements and re-send them. Safe to run concurrently with live emits
 * (acks are idempotent; the publisher dedupes on eventId). Returns a small summary for
 * logging/observability. With a `DrainScope` it runs for one publisher; without, it
 * drains the whole fleet against global config.
 *
 * The sweep reads only DUE work — never the whole lifetime ledger. An event is due when
 * it has no delivery row yet, or its row is unacked, not dead-lettered, and past its
 * `nextAttemptAt`. Each failure bumps the persisted attempt count and pushes the next
 * attempt out exponentially, and once the budget is spent the event dead-letters: parked,
 * surfaced to an operator, still owed, still revivable. Nothing is ever dropped.
 */
export async function drainSettlements(scope: DrainScope = {}): Promise<{
  acked: number;
  pending: number;
  deadLettered: number;
}> {
  const cfg = getConfig();
  const secret = scope.secret ?? cfg.CREDITS_SETTLEMENT_SECRET;
  const originUrl = scope.originUrl ?? cfg.ORIGIN_URL;
  // Dark publisher (or dark gate): no secret, no emit — matches the hot path. Note this
  // returns BEFORE touching the delivery store, so a creds-free self-host never even
  // opens it: the dark-by-default property is unchanged.
  if (!secret) return { acked: 0, pending: 0, deadLettered: 0 };

  const store = getSettlementDeliveryStore();
  const events = await store.due({
    now: Date.now(),
    publisherId: scope.publisherId,
    limit: cfg.SETTLEMENT_DRAIN_BATCH,
  });

  let acked = 0;
  let pending = 0;
  let deadLettered = 0;
  for (const event of events) {
    const out = await deliver(event, secret, originUrl);
    if (out.ok) {
      await store.markAcked(event.id, event.publisherId, Date.now());
      acked++;
      continue;
    }
    const state = await store.markFailed({
      eventId: event.id,
      publisherId: event.publisherId,
      now: Date.now(),
      error: out.error,
      maxAttempts: cfg.SETTLEMENT_MAX_DELIVERY_ATTEMPTS,
      baseMs: cfg.SETTLEMENT_RETRY_BASE_MS,
      capMs: cfg.SETTLEMENT_RETRY_BACKOFF_CAP_MS,
    });
    pending++;
    if (state.deadLetteredAt !== undefined) {
      deadLettered++;
      console.error(
        `[tollgate] settlement ${event.id} DEAD-LETTERED after ${state.attempts} sweeps (${out.error}). ` +
          `The money is still owed — it is parked for operator review, not dropped.`,
      );
    }
  }
  return { acked, pending, deadLettered };
}

/**
 * Start the background drain: one sweep at boot (recovers anything stranded by a
 * crash), then on SETTLEMENT_DRAIN_INTERVAL_MS. No-op when dark or when the
 * interval is 0 (serverless drives the drain with a cron instead). Returns a
 * stop handle for clean shutdown.
 */
export function startSettlementDrain(): { stop: () => void } {
  const cfg = getConfig();
  if (!cfg.CREDITS_SETTLEMENT_SECRET || cfg.SETTLEMENT_DRAIN_INTERVAL_MS === 0) {
    return { stop: () => {} };
  }

  const sweep = (): void => {
    void drainSettlements()
      .then(({ acked, pending, deadLettered }) => {
        if (acked || pending)
          console.log(
            `[tollgate] settlement drain: ${acked} acked, ${pending} pending, ${deadLettered} dead-lettered`,
          );
      })
      .catch((err: unknown) => console.error("[tollgate] settlement drain failed:", err));
  };

  sweep(); // boot recovery
  const timer = setInterval(sweep, cfg.SETTLEMENT_DRAIN_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive just for the drain
  return { stop: () => clearInterval(timer) };
}
