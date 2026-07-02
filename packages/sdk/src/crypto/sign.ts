/**
 * HMAC signing of the settlement body — the producer half of the trust boundary.
 *
 * Pure: no fetch, no ambient clock. The caller passes the unix-seconds timestamp
 * and signs the EXACT raw body bytes it will send — serialize once, sign that
 * string, send that string. The receiver recomputes HMAC-SHA256(`${ts}.${body}`)
 * and rejects a mismatch (401) or a timestamp skewed past the window.
 */
import { createHmac } from "node:crypto";

/** Headers the receiver verifies: a unix-seconds timestamp and the HMAC. */
export interface SignedSettlement {
  timestamp: string;
  signature: string;
}

export function signSettlement(
  rawBody: string,
  secret: string,
  unixSeconds: number,
): SignedSettlement {
  const timestamp = String(unixSeconds);
  const signature =
    "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, signature };
}
