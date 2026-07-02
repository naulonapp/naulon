/**
 * Express settlement receiver — the same logic as the Next receiver
 * (`../next/settlement-receiver.ts`), wrapped for an Express `(req, res)` route.
 * It runs the web-standard handler verbatim, so HMAC verification, the 401/400
 * retry semantics, and the mandatory exactly-once `IdempotencyStore` behave
 * identically across both frameworks.
 *
 * Mount it with `express.raw()` so the body arrives as raw bytes:
 *   app.post("/api/credits/settlement",
 *     express.raw({ type: "*\/*" }),
 *     createExpressSettlementReceiver({ secrets, onEvent, idempotency }));
 */
import { createSettlementReceiver } from "../next/settlement-receiver.ts";
import type { SettlementBody } from "../contract/settlement.ts";
import type { IdempotencyStore } from "../idempotency.ts";
import {
  type ExpressHandler,
  headerValue,
  pipeResponse,
  rawBodyOf,
} from "./_bridge.ts";

export function createExpressSettlementReceiver(opts: {
  /** 1..n shared HMAC secrets; >1 only during a rotation overlap. */
  secrets: string[];
  /** Persist the payout here. Runs at most once per eventId (idempotency-gated). */
  onEvent: (event: SettlementBody) => Promise<void>;
  /** REQUIRED. memoryIdempotencyStore() is dev-only — back it with a DB unique
   *  constraint on eventId in production (the 300s skew window makes an authentic
   *  POST replayable for five minutes). */
  idempotency: IdempotencyStore;
}): ExpressHandler {
  // Reuse the web handler — including its empty-secrets guard (throws here).
  const handler = createSettlementReceiver(opts);
  return async (req, res) => {
    const rawBody = rawBodyOf(req.body, "createExpressSettlementReceiver");
    const headers = new Headers();
    const ts = headerValue(req.headers["x-naulon-timestamp"]);
    const sig = headerValue(req.headers["x-naulon-signature"]);
    if (ts !== undefined) headers.set("x-naulon-timestamp", ts);
    if (sig !== undefined) headers.set("x-naulon-signature", sig);
    const request = new Request("http://settlement.local", { method: "POST", headers, body: rawBody });
    await pipeResponse(await handler(request), res);
  };
}
