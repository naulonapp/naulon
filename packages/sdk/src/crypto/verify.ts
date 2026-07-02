/**
 * HMAC verification of the settlement body — the verify half, written once here
 * instead of hand-rolled per publisher. Authenticity + freshness + shape, in the
 * order the gate's retry semantics depend on:
 *
 *   401 = TRANSIENT (the gate retries) — signature/clock problems.
 *   400 = PERMANENT (the gate gives up) — a malformed body; retrying won't help.
 *
 * Get those status codes wrong and you change the gate's retry behavior, so they
 * are pinned by tests. This proves AUTHENTICITY only; exactly-once PERSISTENCE is
 * the receiver's job (see IdempotencyStore) — the skew window means an authentic
 * POST is replayable for its whole duration.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { settlementBodySchema, type SettlementBody } from "../contract/settlement.ts";

/** Max clock skew (seconds) between the signer and the receiver. */
export const MAX_SKEW_SECONDS = 300;

export type VerifyResult =
  | { ok: true; event: SettlementBody }
  | { ok: false; status: 400 | 401; reason: string };

/** Constant-time compare of the provided signature against each candidate secret
 *  (the array is what makes secret rotation safe — accept old+new during a roll). */
function signatureMatches(
  timestamp: string,
  rawBody: string,
  header: string,
  secrets: string[],
): boolean {
  const provided = Buffer.from(header);
  for (const secret of secrets) {
    const expected = Buffer.from(
      "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"),
    );
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

export function verifySettlement(opts: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  /** 1..n secrets; >1 during a rotation overlap. */
  secrets: string[];
  /** Injectable clock (unix seconds) for tests; defaults to now. */
  now?: number;
}): VerifyResult {
  const { rawBody, timestampHeader, signatureHeader, secrets } = opts;
  if (secrets.length === 0) {
    throw new Error("verifySettlement: at least one secret is required");
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) {
    return { ok: false, status: 401, reason: "bad-timestamp" };
  }
  if (Math.abs(now - Number(timestampHeader)) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: "stale-timestamp" };
  }
  if (!signatureHeader || !signatureMatches(timestampHeader, rawBody, signatureHeader, secrets)) {
    return { ok: false, status: 401, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: "bad-json" };
  }
  const result = settlementBodySchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, status: 400, reason: "invalid-event" };
  }
  return { ok: true, event: result.data as unknown as SettlementBody };
}
