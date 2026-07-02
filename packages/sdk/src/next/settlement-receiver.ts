/**
 * The settlement receiver adapter — the half a publisher most wants handed to
 * them, because HMAC verification + replay defense are easy to get subtly wrong.
 *
 * It wraps `verifySettlement` (authenticity) with the mandatory exactly-once
 * persistence (`IdempotencyStore`): the 300s skew window means an authentic POST
 * is replayable for five minutes, so a money receiver with no dedupe is a
 * double-payout defect. There is deliberately NO dry-run mode — a money receiver
 * gets no public "pretend" path; offline conformance uses `makeSignedSettlementFixture`.
 *
 * Returns a plain `(req: Request) => Promise<Response>` handler — drop it straight
 * into a Next.js App Router route (`export const POST = createSettlementReceiver(...)`),
 * or any framework that speaks web-standard Request/Response.
 */
import { verifySettlement } from "../crypto/verify.ts";
import type { SettlementBody } from "../contract/settlement.ts";
import type { IdempotencyStore } from "../idempotency.ts";

export function createSettlementReceiver(opts: {
  /** 1..n shared HMAC secrets; >1 only during a rotation overlap. */
  secrets: string[];
  /** Persist the payout here. Runs at most once per eventId (idempotency-gated). */
  onEvent: (event: SettlementBody) => Promise<void>;
  /** REQUIRED. memoryIdempotencyStore() satisfies the type for dev, but is NOT
   *  durable — back this with a DB unique-constraint on eventId in production. */
  idempotency: IdempotencyStore;
}): (req: Request) => Promise<Response> {
  if (opts.secrets.length === 0) {
    throw new Error("createSettlementReceiver: at least one secret is required");
  }
  return async (req) => {
    // The signature is over the EXACT bytes — read the raw text, never re-serialize.
    const rawBody = await req.text();
    const result = verifySettlement({
      rawBody,
      timestampHeader: req.headers.get("x-naulon-timestamp"),
      signatureHeader: req.headers.get("x-naulon-signature"),
      secrets: opts.secrets,
    });
    if (!result.ok) {
      // 401 = transient (the gate retries); 400 = permanent (it gives up).
      return Response.json({ error: result.reason }, { status: result.status });
    }
    // Exactly-once: a replay inside the skew window is acknowledged but NOT re-paid.
    const fresh = await opts.idempotency.claim(result.event.eventId);
    if (!fresh) {
      return Response.json({ ok: true, deduped: true });
    }
    await opts.onEvent(result.event);
    return Response.json({ ok: true, deduped: false });
  };
}
