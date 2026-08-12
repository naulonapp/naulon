/**
 * The webhook receiver adapter — the half a publisher most wants handed to them,
 * because HMAC verification + replay defense are easy to get subtly wrong.
 *
 * It wraps `verifyPayload` (authenticity) with the mandatory exactly-once
 * persistence (`IdempotencyStore`): the skew window means an authentic POST is
 * replayable for its whole duration, and delivery is at-least-once by design, so a
 * receiver that writes money with no dedupe is a double-count defect, not a choice.
 *
 * Returns a plain `(req: Request) => Promise<Response>` handler — drop it straight
 * into a Next.js App Router route (`export const POST = createWebhookReceiver(...)`),
 * or any framework that speaks web-standard Request/Response.
 *
 * **What the status codes do.** naulon's sender treats any non-2xx as a failed
 * attempt and retries with backoff until the delivery is exhausted; there is no
 * 400-is-permanent shortcut (that was the deleted origin-mirror's contract, not
 * this one). So a 401 from a secret mismatch will be re-attempted for the whole
 * retry budget — the status is a diagnosis for you, not a signal to us.
 */
import { verifyPayload } from "../crypto/webhook.ts";
import { webhookEnvelopeSchema, type WebhookEnvelope } from "../contract/webhook.ts";
import type { IdempotencyStore } from "../idempotency.ts";

export interface WebhookReceiverOptions {
  /** 1..n endpoint secrets; >1 only during a rotation overlap. */
  secrets: string[];
  /** Handle the event. Runs at most once per `eventId` (idempotency-gated). */
  onEvent: (event: WebhookEnvelope) => Promise<void>;
  /** REQUIRED. memoryIdempotencyStore() satisfies the type for dev, but is NOT
   *  durable — back this with a DB unique-constraint on `eventId` in production. */
  idempotency: IdempotencyStore;
  /** Replay tolerance either side of the signed timestamp. Defaults to 300s. */
  toleranceSeconds?: number;
  /** Injectable clock (unix seconds) for tests; defaults to now. */
  now?: () => number;
}

export function createWebhookReceiver(
  opts: WebhookReceiverOptions,
): (req: Request) => Promise<Response> {
  if (opts.secrets.length === 0) {
    throw new Error("createWebhookReceiver: at least one secret is required");
  }
  return async (req) => {
    // The signature is over the EXACT bytes — read the raw text, never re-serialize.
    const rawBody = await req.text();
    const header = req.headers.get("naulon-signature");
    const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
    // Every candidate secret is tried; that array is what makes a rotation safe.
    const authentic =
      header !== null &&
      opts.secrets.some((s) => verifyPayload(s, rawBody, header, now, opts.toleranceSeconds));
    if (!authentic) {
      return Response.json({ error: "bad-signature" }, { status: 401 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "bad-json" }, { status: 400 });
    }
    const result = webhookEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      return Response.json({ error: "invalid-envelope" }, { status: 400 });
    }
    const event = result.data as WebhookEnvelope;

    // Exactly-once: a redelivery of an event already handled is acknowledged, not re-run.
    const fresh = await opts.idempotency.claim(event.eventId);
    if (!fresh) {
      return Response.json({ ok: true, deduped: true });
    }
    try {
      await opts.onEvent(event);
    } catch (e) {
      // The claim is taken BEFORE the work (that ordering is what makes two
      // concurrent redeliveries safe), so a failed handler must give it back or the
      // retry would be deduped into silence — a settlement you never recorded.
      await opts.idempotency.release?.(event.eventId);
      throw e;
    }
    return Response.json({ ok: true, deduped: false });
  };
}
