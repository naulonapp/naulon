/**
 * Why a presented payment failed — the `payment-failed` observation's REASON.
 *
 * The observation plane already counted these failures; it just never said why. That gap is not
 * cosmetic. Prod 2026-08-03: a publisher pinned `settlement_network` to Base mainnet while buyer
 * sessions were funded on arcTestnet, so every toll died in the USDC transfer. The Audit page showed
 * four `payment-failed` rows carrying `{verdict, kind, slug, price, host, classifiedAs}` and nothing
 * else — indistinguishable from four broke buyers, so the publisher's own misconfiguration was
 * invisible to the one person who could fix it.
 *
 * TWO writers emit `payment-failed`, and they must agree or the Audit page lies about which failure
 * it saw: the OSS gate's own settle tail (`tollgate/src/app.ts`, fleet-proxied traffic) and the
 * cloud's `/verify` BFF (`naulon-cloud/src/enforce-verify.ts`, self-hosted runtimes reporting in).
 * The classifier therefore lives HERE, in shared, consumed by both — one judgement, one owner. A
 * second copy would drift, and a drifted copy is worse than none because the page is trusted.
 *
 * ## Why a closed enum and not the error string
 *
 * The raw `VerifyResult.error` embeds settlement detail: `leg 0 (0xdef): …`,
 * `authorization (to 0xabc, value 5000) != requirements (payTo 0xdef, amount 3000)`. The observation
 * is rendered to the PUBLISHER, so forwarding that string hands them a counterparty address and leg
 * amounts. Returning a member of a fixed set makes the leak structurally impossible instead of a
 * thing each call site has to remember. The buyer still gets the full string in the 402 body — they
 * are the party entitled to it.
 */

/** The closed set. Order is presentation order (most actionable first), not precedence. */
export const PAYMENT_FAILURE_REASONS = [
  /** The payer could not cover the toll on the settlement chain. The publisher-facing signal: if this
   *  is ~100% of attempts, suspect the SETTLEMENT CHAIN, not a run of broke buyers. */
  "insufficient_funds",
  /** A signature/authorization that did not match what was advertised, or failed verification —
   *  a replayed nonce, a mismatched payTo/amount, an expired validity window. */
  "authorization_invalid",
  /** The payment payload was undecodable or structurally wrong (leg count, missing payer). */
  "malformed_payment",
  /** The settlement chain cannot carry this settlement (no Memo predeploy, no configured relayer). */
  "network_unsupported",
  /** Settlement was attempted and failed for a reason this classifier does not recognise. */
  "settlement_failed",
] as const;

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

/**
 * Map a settle failure to its reason. Deliberately conservative: an unrecognised message becomes
 * `settlement_failed` rather than being forced into a specific bucket, because a WRONG specific
 * reason is worse than a vague one — it sends the publisher to fix something that is not broken.
 *
 * Order matters. A shortfall is checked first because its message often also names a leg
 * (`author leg settle failed: …`), which would otherwise match the authorization patterns.
 */
export function classifyPaymentFailure(error: string | undefined | null): PaymentFailureReason {
  const t = (error ?? "").toLowerCase();
  if (!t) return "settlement_failed";
  // Balance first — see the ordering note above. Covers the facilitator's `insufficient_balance`,
  // the ERC-20 revert strings, and the plain-English wordings.
  if (/insufficient|exceeds balance|transfer amount exceeds|not enough|balance too low/.test(t)) {
    return "insufficient_funds";
  }
  // Structure before semantics: a payload we could not decode is not an "invalid authorization",
  // it is a broken client, and the publisher should read it as such.
  if (/malformed|leg count mismatch|missing payer|no settlement legs/.test(t)) return "malformed_payment";
  if (/no memo predeploy|relayer_private_key|unsupported network|no memo/.test(t)) return "network_unsupported";
  if (/!= requirements|verification failed|invalid|nonce|expired|valid ?before|too short/.test(t)) {
    return "authorization_invalid";
  }
  return "settlement_failed";
}
