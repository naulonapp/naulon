// src/webhooks/types.ts — Track C webhooks: event + channel catalogs, the stored shapes, and the
// store seams. Pure declarations (no runtime beyond the catalog guards); consumed across the
// webhooks module. Mirrors src/api-keys/types.ts.

export const WEBHOOK_EVENT_TYPES = ["anomaly.detected", "settlement.completed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export function isWebhookEventType(s: string): s is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(s);
}

/** The four delivery channels. `raw` is our signed generic endpoint; the rest are unsigned chat
 *  "incoming webhooks" (the URL is the credential). */
export const WEBHOOK_CHANNEL_TYPES = ["raw", "slack", "discord", "teams"] as const;
export type WebhookChannelType = (typeof WEBHOOK_CHANNEL_TYPES)[number];
export function isWebhookChannelType(s: string): s is WebhookChannelType {
  return (WEBHOOK_CHANNEL_TYPES as readonly string[]).includes(s);
}

/** Per-endpoint `settlement.completed` body verbosity (Phase 3). `summary` = the legacy
 *  `{tenant,acked,pending}` body (default, non-breaking); `detailed` = the enriched body. */
export const WEBHOOK_PAYLOAD_PROFILES = ["summary", "detailed"] as const;
export type PayloadProfile = (typeof WEBHOOK_PAYLOAD_PROFILES)[number];
export function isPayloadProfile(s: string): s is PayloadProfile {
  return (WEBHOOK_PAYLOAD_PROFILES as readonly string[]).includes(s);
}

/** Stored endpoint. `secret` is non-null only for `raw`, and present only when read via service_role. */
export interface WebhookEndpoint {
  id: string;
  ownerUserId: string;
  channelType: WebhookChannelType;
  hostFilter: string | null;
  url: string; // the actual POST target; service_role only
  secret: string | null; // whsec for raw; null for chat
  eventTypes: WebhookEventType[];
  enabled: boolean;
  description: string | null;
  /** `settlement.completed` body verbosity for this endpoint. `raw` honors it; chat is always the
   *  summary line. Defaults to `summary` (legacy body, non-breaking). */
  payloadProfile: PayloadProfile;
  consecutiveFailures: number;
  disabledAt: number | null;
  disabledReason: string | null;
  createdAt: number;
  createdBy: string;
}

export interface NewWebhookEndpoint {
  ownerUserId: string;
  channelType: WebhookChannelType;
  hostFilter: string | null;
  url: string;
  secret: string | null;
  eventTypes: WebhookEventType[];
  description: string | null;
  /** Optional at the seam — defaults to `summary` when omitted. New endpoints from the UI pass
   *  `detailed`; every other code path keeps the legacy body. */
  payloadProfile?: PayloadProfile;
  createdBy: string;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "exhausted";

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: WebhookEventType | "ping";
  eventId: string;
  payload: unknown; // the CANONICAL event body; channel transform happens at send time
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastStatusCode: number | null;
  lastResponseBody: string | null;
  lastError: string | null;
  createdAt: number;
}

/** A detected event handed to dispatchEvent. `eventId` is the deterministic source dedup key. */
export interface WebhookEvent {
  ownerUserId: string;
  host: string | null;
  type: WebhookEventType;
  eventId: string;
  /** The body enqueued for every deliverable endpoint UNLESS `payloadFor` is set (the safe default;
   *  e.g. the coarse summary body). Dedup + eventId are unaffected by which body is chosen. */
  payload: Record<string, unknown>;
  /** Optional per-endpoint body builder (settlement enrichment): when set, dispatch calls it with
   *  each deliverable endpoint's `payloadProfile` and enqueues the result instead of `payload`.
   *  Called synchronously at enqueue — the hot delivery path (sign/render/dedup) is untouched. */
  payloadFor?: (profile: PayloadProfile) => Record<string, unknown>;
}

export interface WebhookEndpointStore {
  listForOwner(ownerUserId: string): Promise<WebhookEndpoint[]>;
  /** Enabled endpoints for an owner subscribed to `type`, with secret (service_role). */
  listDeliverable(ownerUserId: string, type: WebhookEventType): Promise<WebhookEndpoint[]>;
  get(id: string): Promise<WebhookEndpoint | null>;
  create(input: NewWebhookEndpoint): Promise<WebhookEndpoint>;
  update(
    id: string,
    patch: Partial<
      Pick<WebhookEndpoint, "url" | "eventTypes" | "description" | "enabled" | "secret" | "payloadProfile">
    >,
  ): Promise<WebhookEndpoint | null>;
  delete(id: string): Promise<void>;
  bumpFailures(id: string): Promise<number>;
  resetFailures(id: string): Promise<void>;
  autoDisable(id: string, reason: string, at: number): Promise<void>;
}

export interface WebhookDeliveryStore {
  /** Enqueue one delivery. Idempotent on (endpointId,eventId) — a duplicate returns the EXISTING
   *  row (ON CONFLICT DO NOTHING + read-back), never a second row. */
  enqueue(
    d: Omit<
      WebhookDelivery,
      | "id"
      | "createdAt"
      | "status"
      | "attemptCount"
      | "lastAttemptAt"
      | "lastStatusCode"
      | "lastResponseBody"
      | "lastError"
    > & { id?: string },
  ): Promise<WebhookDelivery>;
  listDue(now: number, limit: number): Promise<WebhookDelivery[]>;
  /** Atomically claim up to `limit` due+pending deliveries, stamping a lease so a CONCURRENT sweep
   *  (a second instance, or a rolling-deploy overlap) cannot claim the same rows — the multi-instance
   *  double-deliver guard. `leaseMs` bounds crashed-worker recovery only; `recordAttempt` clears the
   *  claim, so normal retry timing stays governed by `nextAttemptAt`, never delayed to lease expiry. */
  claimDue(now: number, limit: number, leaseMs: number): Promise<WebhookDelivery[]>;
  listForEndpoint(endpointId: string, cursor: number | null, limit: number): Promise<WebhookDelivery[]>;
  get(id: string): Promise<WebhookDelivery | null>;
  recordAttempt(
    id: string,
    patch: Partial<
      Pick<
        WebhookDelivery,
        | "status"
        | "attemptCount"
        | "nextAttemptAt"
        | "lastAttemptAt"
        | "lastStatusCode"
        | "lastResponseBody"
        | "lastError"
      >
    >,
  ): Promise<void>;
}
