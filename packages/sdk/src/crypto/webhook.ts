/**
 * Stripe-style HMAC signing for `raw` webhook deliveries — the shared half of the
 * trust boundary. The header value is `t=<unix_secs>,v1=<hex HMAC-SHA256>` over
 * `${t}.${body}`, keyed by the endpoint secret; hex (Stripe), 300s default replay
 * tolerance. Chat channels (Slack/Discord/Teams) are never signed — there the URL
 * is the credential.
 *
 * This lives in the PUBLISHER package because the verify side is what a site
 * actually needs to install. `@naulon/shared`'s webhook sender re-imports
 * `signPayload` from here, so the bytes a publisher verifies are produced by this
 * exact function — one implementation, not a mirror that can drift. The customer
 * doc's verify snippet IS `verifyPayload`, so the doc example is the code we test.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The header the signature travels in. */
export const WEBHOOK_SIGNATURE_HEADER = "naulon-signature";

/** Default replay tolerance, in seconds, either side of `t`. */
export const WEBHOOK_MAX_SKEW_SECONDS = 300;

export function signPayload(secret: string, body: string, tSecs: number): string {
  const sig = createHmac("sha256", secret).update(`${tSecs}.${body}`).digest("hex");
  return `t=${tSecs},v1=${sig}`;
}

export function verifyPayload(
  secret: string,
  body: string,
  header: string,
  nowSecs: number,
  toleranceSecs = WEBHOOK_MAX_SKEW_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? ["", ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!Number.isFinite(t) || typeof v1 !== "string" || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowSecs - t) > toleranceSecs) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
}
