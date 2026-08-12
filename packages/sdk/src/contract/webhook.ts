/**
 * The webhook wire contract — the body naulon POSTs to a publisher's `raw`
 * endpoint when something happens on their account (a settlement lands, an
 * anomaly fires). It is the RECEIVE side of the only settlement-notification
 * path there is: the origin-mirror (`POST {origin}/api/credits/settlement`) was
 * deleted in WH-1 P3, so a publisher who wants to know that money moved
 * subscribes to `settlement.completed` here.
 *
 * The producer is `@naulon/shared`'s webhook core (`CanonicalEvent` in
 * `webhooks/transform.ts`); this is its mirror, written once for the receive side
 * instead of hand-rolled per publisher. The dependency points one way — shared
 * builds on this package, never the reverse — so `settlementEmitParity.test.ts`
 * over there pins the two shapes together.
 *
 * `type` is deliberately an open `string`, not a closed union. A gate that starts
 * emitting a new event type must not break a deployed receiver's parse; switch on
 * the types you handle and ignore the rest.
 */
import { z } from "zod";

/** Event types naulon emits today. Non-exhaustive by design — see the note above. */
export const KNOWN_WEBHOOK_EVENT_TYPES = [
  "anomaly.detected",
  "settlement.completed",
  "ping",
] as const;

export type KnownWebhookEventType = (typeof KNOWN_WEBHOOK_EVENT_TYPES)[number];

/** The exact JSON body a `raw` webhook endpoint receives. */
export interface WebhookEnvelope {
  /** Delivery id — unique per (endpoint, attempt-chain). Also sent as `Naulon-Id`. */
  id: string;
  /** e.g. `settlement.completed`. Also sent as `Naulon-Event`. */
  type: string;
  /** The SOURCE event id — stable across endpoints and redeliveries. Dedupe on this. */
  eventId: string;
  /** Unix milliseconds the source event was created (not the send time). */
  createdAt: number;
  /** The event body. Shape depends on `type` (and, for settlement, the endpoint's payload profile). */
  data: unknown;
}

export const webhookEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    eventId: z.string().min(1),
    createdAt: z.number().int(),
    data: z.unknown(),
  })
  // Not `.strict()`: an added field must never turn a valid delivery into a 400.
  .loose();
