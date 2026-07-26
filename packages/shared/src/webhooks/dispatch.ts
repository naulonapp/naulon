// src/webhooks/dispatch.ts — the two halves of webhook delivery, deliberately decoupled (design §2).
//
//   makeDispatchEvent(deps)  → ENQUEUE ONLY. Called from inside the event sweeps (anomaly /
//                              settlement). Writes one pending delivery row per deliverable,
//                              flag-ON, host-matched endpoint and returns. NO HTTP — so a slow
//                              endpoint can never stall settlement detection (the v1 head-of-line
//                              blocking bug). Idempotent via the store's ON CONFLICT dedup.
//
//   sweepWebhookDeliveries(deps) → the ONLY place HTTP happens. Runs on its OWN scheduler interval.
//                              Picks up due deliveries, sends them in bounded-concurrency chunks,
//                              folds each result into the delivery row + the endpoint failure
//                              counter (backoff / exhaust / auto-disable). Per-delivery isolated.

import type {
  WebhookChannelType,
  WebhookDelivery,
  WebhookDeliveryStore,
  WebhookEndpointStore,
  WebhookEvent,
} from "./types.ts";
import type { CanonicalEvent } from "./transform.ts";
import type { WebhookSender } from "./sender.ts";

// Retry offsets between attempts: 5s, 5m, 30m, 2h, 5h, 10h, 10h → 7 offsets ⇒ 8 attempts total.
export const BACKOFF_OFFSETS_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  10 * 3_600_000,
] as const;
export const MAX_ATTEMPTS = BACKOFF_OFFSETS_MS.length + 1; // 8

// The claim lease the sweep stamps when it picks up a delivery. recordAttempt clears the claim, so
// the lease ONLY governs recovery of a row whose worker died mid-attempt (re-claimable once it
// lapses). The INVARIANT: the lease must comfortably exceed the WORST-CASE wall-clock from a row's
// claim to its recordAttempt — which, for the LAST row of a full batch, is
//   ceil(CLAIM_LIMIT / WEBHOOK_SWEEP_CONCURRENCY) * WEBHOOK_TIMEOUT_MS
// = ceil(200/10) * 15s = 300s if every endpoint in the batch times out. Below that, a concurrent
// sweep could re-claim the tail and double-send. 10 min gives ~2x headroom over that ceiling.
export const CLAIM_LIMIT = 200;
export const CLAIM_LEASE_MS = 600_000;

export interface DispatchDeps {
  endpoints: WebhookEndpointStore;
  deliveries: WebhookDeliveryStore;
  sender: WebhookSender;
  autoDisableThreshold: number;
  concurrency: number;
  /** Per-channel release-flag gate. When provided, a flag-OFF channel is skipped at enqueue. */
  isChannelEnabled?: (ct: WebhookChannelType) => Promise<boolean>;
  now?: () => number;
}

export interface WebhookSweepSummary {
  attempted: number;
  delivered: number;
  exhausted: number;
}

/** ENQUEUE ONLY — no HTTP. Writes a pending row per deliverable, flag-ON, host-matched endpoint. */
export function makeDispatchEvent(deps: DispatchDeps): (e: WebhookEvent) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (e) => {
    const eps = await deps.endpoints.listDeliverable(e.ownerUserId, e.type);
    for (const ep of eps) {
      if (ep.hostFilter && e.host && ep.hostFilter !== e.host) continue;
      if (deps.isChannelEnabled && !(await deps.isChannelEnabled(ep.channelType))) continue;
      // Per-endpoint body: settlement enrichment renders each endpoint's profile at enqueue and
      // stores the result, so the send path stays profile-agnostic. Everything else uses e.payload.
      const payload = e.payloadFor ? e.payloadFor(ep.payloadProfile) : e.payload;
      await deps.deliveries.enqueue({
        endpointId: ep.id,
        eventType: e.type,
        eventId: e.eventId,
        host: e.host, // stamp the tenant host for operator dead-letter scoping (isolation key)
        payload,
        nextAttemptAt: now(), // due immediately; the sweep does attempt #1 on its next tick
      });
    }
  };
}

/** The ONLY place HTTP happens. Bounded-concurrency over the due set. */
export async function sweepWebhookDeliveries(
  deps: DispatchDeps,
  nowMs?: number,
): Promise<WebhookSweepSummary> {
  const now = nowMs ?? (deps.now ?? Date.now)();
  const due = await deps.deliveries.claimDue(now, CLAIM_LIMIT, CLAIM_LEASE_MS);
  const summary: WebhookSweepSummary = { attempted: 0, delivered: 0, exhausted: 0 };
  for (let i = 0; i < due.length; i += deps.concurrency) {
    const chunk = due.slice(i, i + deps.concurrency);
    const results = await Promise.allSettled(chunk.map((d) => attempt(deps, d, now)));
    for (const r of results) {
      summary.attempted += 1;
      if (r.status === "fulfilled") {
        if (r.value === "delivered") summary.delivered += 1;
        if (r.value === "exhausted") summary.exhausted += 1;
      }
    }
  }
  return summary;
}

/** Send one delivery; fold the result into the delivery row + the endpoint failure counter.
 *  Returns the new status for the summary. Per-delivery isolated — a throw here never aborts the
 *  chunk (the caller wraps in allSettled). */
async function attempt(deps: DispatchDeps, d: WebhookDelivery, now: number): Promise<WebhookDelivery["status"]> {
  const ep = await deps.endpoints.get(d.endpointId);
  if (!ep || !ep.enabled) {
    await deps.deliveries.recordAttempt(d.id, {
      status: "failed",
      lastError: "endpoint disabled",
      nextAttemptAt: null,
      lastAttemptAt: now,
    });
    return "failed";
  }

  const canonical: CanonicalEvent = {
    id: d.id,
    type: d.eventType,
    eventId: d.eventId,
    createdAt: d.createdAt,
    data: d.payload,
  };
  const res = await deps.sender
    .send(ep.channelType, d.eventType, ep.url, ep.secret ?? "", d.id, canonical, now)
    .catch((err: unknown): import("./sender.ts").SendResult => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  const attemptCount = d.attemptCount + 1;

  if (res.ok) {
    await deps.deliveries.recordAttempt(d.id, {
      status: "delivered",
      attemptCount,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastStatusCode: res.statusCode ?? null,
      lastResponseBody: res.body ?? null,
      lastError: null,
    });
    await deps.endpoints.resetFailures(ep.id);
    return "delivered";
  }

  // A blocked (SSRF / disallowed host / non-https) result is permanent — do not retry, do not
  // count toward auto-disable (it is a config error, not a flaky endpoint).
  if (res.blocked) {
    await deps.deliveries.recordAttempt(d.id, {
      status: "failed",
      attemptCount,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastStatusCode: res.statusCode ?? null,
      lastError: res.error ?? null,
    });
    return "failed";
  }

  const offset = BACKOFF_OFFSETS_MS[attemptCount - 1]; // attemptCount=1 ⇒ first retry offset
  if (offset === undefined) {
    await deps.deliveries.recordAttempt(d.id, {
      status: "exhausted",
      attemptCount,
      nextAttemptAt: null,
      lastAttemptAt: now,
      lastStatusCode: res.statusCode ?? null,
      lastError: res.error ?? null,
    });
  } else {
    const wait = Math.max(offset, res.retryAfterMs ?? 0); // honor Retry-After (429)
    await deps.deliveries.recordAttempt(d.id, {
      status: "pending",
      attemptCount,
      nextAttemptAt: now + wait,
      lastAttemptAt: now,
      lastStatusCode: res.statusCode ?? null,
      lastError: res.error ?? null,
    });
  }

  const failures = await deps.endpoints.bumpFailures(ep.id);
  if (failures >= deps.autoDisableThreshold) {
    await deps.endpoints.autoDisable(ep.id, "auto: sustained delivery failure", now);
  }
  return offset === undefined ? "exhausted" : "pending";
}
