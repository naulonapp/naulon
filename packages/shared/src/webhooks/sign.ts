// src/webhooks/sign.ts — Stripe-style HMAC signing for `raw` webhook deliveries (chat channels
// never call this). Header value is `t=<unix_secs>,v1=<hex HMAC-SHA256>` over `${t}.${body}`,
// keyed by the endpoint secret. Hex (Stripe), 300s default replay tolerance. The customer-doc
// verify snippet IS verifyPayload, so the doc example is the code we test.

import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, body: string, tSecs: number): string {
  const sig = createHmac("sha256", secret).update(`${tSecs}.${body}`).digest("hex");
  return `t=${tSecs},v1=${sig}`;
}

export function verifyPayload(
  secret: string,
  body: string,
  header: string,
  nowSecs: number,
  toleranceSecs = 300,
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
