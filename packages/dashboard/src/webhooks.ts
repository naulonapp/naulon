/**
 * Webhooks — the console's read plane over machinery that has been in the gate the whole time and
 * has never had a face. `NAULON_WEBHOOK_ENDPOINTS` configures endpoints, `webhookSink` fires them,
 * `dispatch` retries and dead-letters them, and until now the only way to learn whether a
 * settlement notification actually landed was to read the receiving server's logs.
 *
 * Two things shape this module, and both are limitations rather than choices:
 *
 *   1. ENDPOINTS ARE ENV, SO THERE IS NO WRITE PATH. The hosted portal creates, edits, toggles and
 *      deletes endpoints against a table. Here the operator's `.env` IS the store (EnvConfigStore
 *      rejects every mutation), so this surface reads and pings — it never pretends to own a row it
 *      cannot change. What the portal renders as controls, this renders as state.
 *
 *   2. THE GATE IS A DIFFERENT PROCESS. Its EnvConfigStore's failure counters and transient
 *      auto-disable live in ITS memory and are unreachable from here. So endpoint health is derived
 *      from the delivery journal — the one plane both processes share — and this module never
 *      reports a liveness fact it cannot actually observe.
 *
 * THE SECRET IS MASKED IN EVERY MODE. Wallet masking is public-mode-only because a wallet is public
 * on-chain anyway; a `whsec_…` is a signing key, and there is no mode in which shipping one to a
 * browser is correct. `maskSecret` is applied at the boundary, so no route can forget.
 */
import {
  JsonlWebhookDeliveryStore,
  getConfig,
  parseWebhookEndpointsEnv,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpointSpec,
  type WebhookEventType,
} from "@naulon/shared";

/** How many deliveries the log carries. Beyond this the operator wants the receiving server's logs. */
export const DELIVERY_LIMIT = 100;

/** One configured endpoint, as the browser is allowed to see it. */
export interface WebhookEndpointView {
  id: string;
  /** Env endpoints are always the signed generic channel — chat channels are a hosted feature. */
  channelType: "raw";
  url: string;
  /** Enough to tell WHICH secret is configured, never enough to sign with it. */
  secretMasked: string;
  eventTypes: WebhookEventType[];
  hostFilter: string | null;
  counts: { total: number; pending: number; delivered: number; failed: number; exhausted: number };
  /** Trailing run of deliveries that did not land, newest-first. Derived — see the module note. */
  consecutiveFailures: number;
  lastAttemptAt: number | null;
  lastStatus: WebhookDeliveryStatus | null;
}

export interface WebhooksView {
  /** False ⇒ the emit is dark: no endpoints, no sweep, no POST. The empty state that teaches. */
  configured: boolean;
  /** A malformed NAULON_WEBHOOK_ENDPOINTS, reported rather than swallowed or thrown at the page. */
  envError: string | null;
  endpoints: WebhookEndpointView[];
  deliveries: WebhookDelivery[];
  deadLettered: number;
  /** 0 ⇒ the sweep is disabled, so a queued delivery will sit until something drives it. */
  sweepIntervalMs: number;
}

/**
 * Show the prefix and the last four, never the middle. A `whsec_` is meaningful to an operator only
 * as an identity ("is this the key I put in .env?"), and the tail is enough for that.
 *
 * A secret too short to mask safely collapses to the marker entirely: revealing "most of" a short
 * secret is worse than revealing nothing, and the operator can still read their own .env.
 */
export function maskSecret(secret: string): string {
  const [prefix, rest] = secret.startsWith("whsec_") ? ["whsec_", secret.slice(6)] : ["", secret];
  if (rest.length < 8) return `${prefix}…`;
  return `${prefix}…${rest.slice(-4)}`;
}

/** The synthesized id EnvConfigStore gives the nth env endpoint. Kept in one place, used by both. */
export const envEndpointId = (i: number): string => `env:${i}`;

/**
 * Deliveries that did not land, counting back from the newest, stopping at the first that did.
 *
 * `pending` rows are SKIPPED rather than counted or treated as a reset: a delivery still in flight
 * has no verdict yet, and letting one both hide a failing run and read as a success would make this
 * number swing on nothing but timing.
 */
export function trailingFailures(deliveries: WebhookDelivery[]): number {
  let n = 0;
  for (const d of deliveries) {
    if (d.status === "delivered") break;
    if (d.status === "pending") continue;
    n += 1;
  }
  return n;
}

/** Roll one endpoint's deliveries into the counts the row renders. */
function countsFor(deliveries: WebhookDelivery[]): WebhookEndpointView["counts"] {
  const counts = { total: deliveries.length, pending: 0, delivered: 0, failed: 0, exhausted: 0 };
  for (const d of deliveries) counts[d.status] += 1;
  return counts;
}

/** Project one env spec + its deliveries (newest first) into the row the browser receives. */
export function toEndpointView(spec: WebhookEndpointSpec, index: number, deliveries: WebhookDelivery[]): WebhookEndpointView {
  const newest = deliveries[0] ?? null;
  return {
    id: envEndpointId(index),
    channelType: "raw",
    url: spec.url,
    secretMasked: maskSecret(spec.secret),
    eventTypes: spec.events,
    hostFilter: spec.hostFilter,
    counts: countsFor(deliveries),
    consecutiveFailures: trailingFailures(deliveries),
    lastAttemptAt: newest?.lastAttemptAt ?? null,
    lastStatus: newest?.status ?? null,
  };
}

/** The delivery journal the gate writes. Constructed per call so a config change is picked up. */
export function deliveryStore(): JsonlWebhookDeliveryStore {
  return new JsonlWebhookDeliveryStore({ path: () => getConfig().WEBHOOK_DELIVERIES_PATH });
}

/**
 * Read the env specs, or the reason they could not be read. `parseWebhookEndpointsEnv` throws by
 * design (a self-hoster should learn about a broken endpoint list at boot, not at the first missed
 * settlement) — but a console page must not 500 because of it. The message is what the operator
 * needs, so it is surfaced verbatim.
 */
export function readSpecs(): { specs: WebhookEndpointSpec[]; envError: string | null } {
  try {
    return { specs: parseWebhookEndpointsEnv(getConfig().NAULON_WEBHOOK_ENDPOINTS), envError: null };
  } catch (err) {
    return { specs: [], envError: err instanceof Error ? err.message : String(err) };
  }
}

/** Everything `/api/webhooks` returns. */
export async function buildWebhooksView(): Promise<WebhooksView> {
  const { specs, envError } = readSpecs();
  const store = deliveryStore();
  const deliveries = await store.listAll(DELIVERY_LIMIT);

  const byEndpoint = new Map<string, WebhookDelivery[]>();
  for (const d of deliveries) {
    const list = byEndpoint.get(d.endpointId);
    if (list) list.push(d);
    else byEndpoint.set(d.endpointId, [d]);
  }

  return {
    configured: specs.length > 0,
    envError,
    endpoints: specs.map((s, i) => toEndpointView(s, i, byEndpoint.get(envEndpointId(i)) ?? [])),
    deliveries,
    deadLettered: deliveries.filter((d) => d.status === "exhausted").length,
    sweepIntervalMs: getConfig().WEBHOOK_SWEEP_INTERVAL_MS,
  };
}

export type PingResult =
  | { ok: true; deliveryId: string; sweepIntervalMs: number }
  | { ok: false; error: string };

/**
 * Queue a test ping for one configured endpoint.
 *
 * The ping is ENQUEUED, not sent: the gate owns the secret, the signing and the sender, and the
 * console owning a second send path would mean two implementations of the thing being tested. So it
 * goes through the real delivery path and the operator sees the real result — which is also exactly
 * what the hosted portal does with its "send test event".
 *
 * `endpointId` is matched against the configured endpoints, so this can only ever target the
 * operator's own env, never a host supplied by the request.
 */
export async function queuePing(endpointId: string, now: number = Date.now()): Promise<PingResult> {
  const { specs, envError } = readSpecs();
  if (envError) return { ok: false, error: envError };
  const index = specs.findIndex((_, i) => envEndpointId(i) === endpointId);
  const spec = specs[index];
  if (!spec) return { ok: false, error: "unknown endpoint" };

  const delivery = await deliveryStore().enqueue({
    endpointId,
    eventType: "ping",
    // Unique per press, so a second ping is a second delivery rather than deduped into the first.
    eventId: `ping:${endpointId}:${now}`,
    payload: { detail: "test ping" },
    nextAttemptAt: now,
    // An endpoint pinned to one site carries that host; an all-sites endpoint has no single emitter.
    host: spec.hostFilter,
  });
  return { ok: true, deliveryId: delivery.id, sweepIntervalMs: getConfig().WEBHOOK_SWEEP_INTERVAL_MS };
}

/**
 * Re-queue one delivery: pending, due now, attempts reset. Mirrors the portal's Resend, including
 * that it applies to any non-pending row rather than only a dead letter — an operator who fixed
 * their receiver wants the failed one re-sent, not just the exhausted one.
 */
export async function resendDelivery(deliveryId: string, now: number = Date.now()): Promise<{ ok: boolean; error?: string }> {
  const store = deliveryStore();
  const d = await store.get(deliveryId);
  if (!d) return { ok: false, error: "unknown delivery" };
  if (d.status === "pending") return { ok: false, error: "that delivery is already queued" };
  await store.recordAttempt(d.id, { status: "pending", attemptCount: 0, nextAttemptAt: now, lastError: null });
  return { ok: true };
}
