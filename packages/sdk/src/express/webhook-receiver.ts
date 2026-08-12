/**
 * Express webhook receiver — the same logic as the Next receiver
 * (`../next/webhook-receiver.ts`), wrapped for an Express `(req, res)` route. It
 * runs the web-standard handler verbatim, so HMAC verification and the mandatory
 * exactly-once `IdempotencyStore` behave identically across both frameworks.
 *
 * Mount it with `express.raw()` so the body arrives as raw bytes:
 *   app.post("/naulon-hook",
 *     express.raw({ type: "*\/*" }),
 *     createExpressWebhookReceiver({ secrets, onEvent, idempotency }));
 */
import { createWebhookReceiver, type WebhookReceiverOptions } from "../next/webhook-receiver.ts";
import { type ExpressHandler, headerValue, pipeResponse, rawBodyOf } from "./_bridge.ts";

export function createExpressWebhookReceiver(opts: WebhookReceiverOptions): ExpressHandler {
  // Reuse the web handler — including its empty-secrets guard (throws here).
  const handler = createWebhookReceiver(opts);
  return async (req, res) => {
    const rawBody = rawBodyOf(req.body, "createExpressWebhookReceiver");
    const headers = new Headers();
    const sig = headerValue(req.headers["naulon-signature"]);
    if (sig !== undefined) headers.set("naulon-signature", sig);
    const request = new Request("http://webhook.local", { method: "POST", headers, body: rawBody });
    await pipeResponse(await handler(request), res);
  };
}
