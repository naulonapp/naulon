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
 *     engine. Re-reads the event ledger, skips anything IA has acked, and
 *     re-sends the rest with a bounded, re-signed, backed-off retry.
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
import { readAll } from "./eventLog.ts";
import { isAcked, markAcked } from "./settlementOutbox.ts";

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
 * Deliver one event with a bounded, re-signed, backed-off retry. Returns true
 * once IA has acked it (and records the ack). Used by the drain; the hot path
 * uses a single `attempt` instead so it never stalls the response.
 */
async function deliver(event: AttributedEvent, secret: string, originUrl: string): Promise<boolean> {
  const max = getConfig().SETTLEMENT_MAX_ATTEMPTS;
  for (let i = 0; i < max; i++) {
    const out = await attempt(event, secret, originUrl);
    if (out.ok) {
      await markAcked(event.id);
      return true;
    }
    if (!out.retry) {
      console.error(`[tollgate] settlement ${event.id} permanently rejected (${out.reason})`);
      return false; // a 400 won't fix itself — stop, don't burn the budget
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
      return false;
    }
    if (i < max - 1) await sleep(250 * 2 ** i); // 250ms, 500, 1s, 2s…
  }
  return false;
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
  if (await isAcked(event.id)) return; // already confirmed (e.g. drain beat us)

  const out = await attempt(event, secret, originUrl);
  if (out.ok) await markAcked(event.id);
  // A miss is expected and fine — the drain guarantees eventual delivery.
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
 * Sweep the ledger and re-send every event IA hasn't acked. Safe to run
 * concurrently with live emits (acks are idempotent; IA dedupes). Returns a
 * small summary for logging/observability. With a `DrainScope` it runs for one
 * publisher; without, it drains the whole ledger against global config.
 */
export async function drainSettlements(scope: DrainScope = {}): Promise<{ acked: number; pending: number }> {
  const cfg = getConfig();
  const secret = scope.secret ?? cfg.CREDITS_SETTLEMENT_SECRET;
  const originUrl = scope.originUrl ?? cfg.ORIGIN_URL;
  // Dark publisher (or dark gate): no secret, no emit — matches the hot path.
  if (!secret) return { acked: 0, pending: 0 };

  const events = await readAll(scope.publisherId);
  let acked = 0;
  let pending = 0;
  for (const event of events) {
    if (await isAcked(event.id)) continue;
    if (await deliver(event, secret, originUrl)) acked++;
    else pending++;
  }
  return { acked, pending };
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
      .then(({ acked, pending }) => {
        if (acked || pending) console.log(`[tollgate] settlement drain: ${acked} acked, ${pending} pending`);
      })
      .catch((err: unknown) => console.error("[tollgate] settlement drain failed:", err));
  };

  sweep(); // boot recovery
  const timer = setInterval(sweep, cfg.SETTLEMENT_DRAIN_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive just for the drain
  return { stop: () => clearInterval(timer) };
}
