/**
 * The paid-fetch loop shared by every buyer rail: probe → re-quote-and-abort-if-moved →
 * build the payment-signature (the ONE rail-specific step) → paid GET → classify. Extracted
 * from memoBuyer/gatewayBuyer so a third buyer (railBuyer) reuses it without a third copy of
 * the loop. Behaviour is byte-identical to the two originals (their suites are the regression).
 */
import {
  AGENT_UA,
  classifyPaymentError,
  classifySignerRefusal,
  probe,
  probeFailure,
  tollMovedOrNull,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { agentFetch } from "./sign.ts";

/** Build the base64 `payment-signature` value for a quote — the single step the rails diverge on. */
export type BuildPayment = (quoted: Quoted, nowMs: number) => Promise<string>;

/** Classify a throw from `buildPayment` into a typed Fetched — the rail's catch-branch. */
export type OnSignError = (error: string) => Fetched;

export async function runPaidFetch(
  url: string,
  kind: "read" | "citation",
  address: `0x${string}`,
  guard: PayGuard | undefined,
  buildPayment: BuildPayment,
  onSignError: OnSignError,
): Promise<Fetched> {
  const outcome = await probe(url, kind, address);
  if (outcome.status !== "gated") return probeFailure(outcome, url);
  const quoted = outcome.quoted;
  // Re-quote at pay time and abort if the toll moved past the authorized ceiling.
  const moved = tollMovedOrNull(quoted, guard);
  if (moved) return moved;
  // Signing and the paid fetch are wrapped SEPARATELY, because their non-spend failures classify
  // differently: a build/sign throw is rail-specific (a hosted session signer THROWS a coded grant
  // refusal → needs_topup; a config/payload fault → the rail's fallback, memo→origin_error,
  // gateway→classifyPaymentError), while a paid-GET socket throw (DNS/connection-refused) is
  // rail-agnostic — always a retryable origin_error. Keeping them in one try (as a naive extract
  // would) routes a socket error through the sign classifier, which mislabels gateway's ECONNREFUSED
  // as `rejected` instead of `origin_error`. Neither must escape as a raw rejection: the host's retry
  // loop only ever inspects a resolved Fetched.
  const nowMs = Date.now();
  let paymentSignature: string;
  try {
    paymentSignature = await buildPayment(quoted, nowMs);
  } catch (err) {
    return onSignError(err instanceof Error ? err.message : String(err));
  }
  let res: Awaited<ReturnType<typeof agentFetch>>;
  try {
    res = await agentFetch(url, {
      headers: {
        "user-agent": AGENT_UA,
        "x-naulon-agent": address,
        "x-naulon-kind": kind,
        "payment-signature": paymentSignature,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, errorCode: "origin_error", retryable: true };
  }
  if (res.status === 402) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const error = body.error ?? "payment rejected";
    return { ok: false, error, ...classifyPaymentError(error) };
  }
  if (!res.ok) return { ok: false, error: `origin returned ${res.status}`, errorCode: "origin_error", retryable: true };
  let settlementRef: string | undefined;
  const respHeader = res.headers.get("payment-response");
  if (respHeader) {
    try {
      settlementRef = (JSON.parse(Buffer.from(respHeader, "base64").toString("utf8")) as {
        transaction?: string;
      }).transaction;
    } catch {
      /* ignore */
    }
  }
  const license = res.headers.get("x-naulon-license") ?? undefined;
  return { ok: true, content: await res.text(), settlementRef, paidUsdc: quoted.priceUsdc, license };
}

// Re-export the two classifiers so a rail's `onSignError` can build the same typed result the
// memo/gateway catch-branches do without a second import site. (They live in buyer.ts.)
export { classifyPaymentError, classifySignerRefusal };
