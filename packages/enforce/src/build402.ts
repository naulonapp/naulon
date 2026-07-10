/**
 * x402 BUILD side — assembling the 402 challenge a buyer signs against.
 *
 * This is the pure, settle-free half of the x402 flow: the `PAYMENT-REQUIRED`
 * header consts, the `PaymentRequirements` shape, and `build402` (the per-leg
 * assembly the gate AND the in-app enforce middleware both need to emit a 402).
 * Its only deps are `@naulon/shared`, `./nonce.ts`, and `./pricing.ts` — no
 * settlement, no `pendingLegs`, no `arcRelay`, no Circle facilitator. The SETTLE
 * half (`verifyAndSettle`, `drainPendingLegs`, the signature builders) lives in
 * `@naulon/tollgate`'s `x402.ts` and imports the build-side symbols from here.
 *
 * payTo is ONE address per x402 payment (the primary author). The recursive
 * co-author split is recorded on the event and reconciled by the attribution
 * service's onward payouts — see packages/attribution.
 */
import {
  activeNetwork,
  gatewayExtra,
  getConfig,
  primaryPayee,
  splitAuthorLegs,
  toAtomicUsdc,
} from "@naulon/shared";
import { issueNonce, type NonceBinding } from "./nonce.ts";
import type { Quote } from "./pricing.ts";

const cfg = getConfig();

// Validity window (seconds) we advertise in the x402 quote — the payer signs
// validBefore = now + this. Circle's Gateway facilitator rejects `verify` unless
// the REMAINING validity at verify time is still >= 7 days (604800s). The SDK
// client clamps short windows up (Math.max(maxTimeoutSeconds, 604800+100)), so an
// SDK buyer survives a low value, but a non-SDK buyer that trusts our advertised
// number verbatim fails `authorization_validity_too_short` when it is below the
// floor. So we advertise above the floor with margin (default 8d, configurable).
// Was a hardcoded 345_600 (4d) — below the floor, a footgun for non-SDK buyers.
export const MAX_TIMEOUT_SECONDS = cfg.X402_MAX_TIMEOUT_SECONDS;

/** x402 header names (Circle/x402 spec). */
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Minimal x402 PaymentRequirements (Gateway batching variant). */
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string; // atomic USDC (6 decimals)
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  /** Optional on-chain memo reconciliation id (Arc only). Carried from the quote;
   *  read ONLY by the self-relay settle path on a memo-capable network. */
  memoId?: string;
}

export function buildRequirements(quote: Quote): PaymentRequirements {
  const net = activeNetwork();
  return {
    scheme: "exact",
    network: net.network,
    asset: net.usdc,
    amount: toAtomicUsdc(quote.price as number),
    // One on-chain recipient (the highest-share author); the full co-author split
    // is recorded on the event. Shared with the settlement builder so both agree.
    payTo: primaryPayee(quote.payees, cfg.PRIMARY_PAYEE_TIEBREAK),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: gatewayExtra(net),
    // Carried only when the quote supplies one; the self-relay path reads it on a
    // memo-capable network. Harmless on Base (ignored by the Gateway settle path).
    ...(quote.memoId ? { memoId: quote.memoId } : {}),
  };
}

/** The payment facts a nonce is bound to — derived from the requirements. */
export function bindingOf(r: PaymentRequirements): NonceBinding {
  return { amount: r.amount, payTo: r.payTo, network: r.network };
}

/** Base64 `PAYMENT-REQUIRED` header value for a 402.
 *
 * In mock mode the `extra` carries our replay nonce (the offline buyer echoes it
 * back and we consume it). In gateway mode `extra` stays exactly the Gateway
 * batching descriptor `{name, version, verifyingContract}` — matching
 * circlefin/arc-nanopayments. Circle's facilitator compares the signed `accepted`
 * against the requirements, so an extra field there (or a per-request rebuild with
 * a fresh nonce) makes verify fail; on-chain deposit-backed settlement is the real
 * replay guard in gateway mode. */
/** A settlement leg paired with the x402 requirements a buyer signs for it. Leg 0
 *  is always the primary author leg (the stock single-author toll); the rest are
 *  the publisher-declared `extraLegs`, each its own direct buyer→payTo transfer. */
export interface SettlementLegReq {
  /** Opaque ledger/dashboard label ("author" for the primary). No protocol meaning. */
  role: string;
  requirements: PaymentRequirements;
}

export function build402(quote: Quote, resourceUrl: string, now: number): {
  requirements: PaymentRequirements;
  legs: SettlementLegReq[];
  header: string;
} {
  // The author (primary) leg, then the co-author split legs (if any), then one
  // requirement per additive extra leg — all sharing the same network/asset/Gateway
  // descriptor, each its own payTo + amount.
  const requirements = buildRequirements(quote);

  // Co-author on-chain split (opt-in, multi-author only): DIVIDE the author price into
  // the primary's synchronous (content-gating) leg + one DEFERRED leg per other
  // co-author. Custody-free split-at-source — every leg is a direct buyer→author
  // transfer, so no leg ever holds a different author's cut. The buyer's total is
  // unchanged (price is divided, not added to). Off / single-author → `requirements`
  // keeps the full price and no co-author legs exist, byte-identical to the stock toll.
  const coauthorLegs: SettlementLegReq[] = [];
  if (quote.coauthorSplit && quote.payees.length > 1) {
    // toAtomicUsdc returns the atomic micro-USDC as a string; splitMicro works in
    // integer micro units, exact for any realistic toll (well within Number range).
    const atomicPrice = Number(toAtomicUsdc(quote.price as number));
    const split = splitAuthorLegs(quote.payees, atomicPrice, cfg.PRIMARY_PAYEE_TIEBREAK);
    // Reduce the author leg to the primary's OWN share, mutated in place so leg 0 stays
    // the same object the returned `requirements` and the nonce loop below rely on.
    requirements.amount = split.primaryAmountMicro;
    requirements.payTo = split.primaryPayTo;
    for (const leg of split.coauthorLegs) {
      coauthorLegs.push({
        role: "coauthor",
        requirements: { ...requirements, payTo: leg.payTo, amount: leg.amountMicro, extra: { ...requirements.extra } },
      });
    }
  }

  const legs: SettlementLegReq[] = [
    { role: "author", requirements },
    ...coauthorLegs,
    ...quote.extraLegs.map((leg) => ({
      role: leg.role,
      requirements: { ...requirements, payTo: leg.payTo, amount: leg.amount, extra: { ...requirements.extra } },
    })),
  ];

  // Mock mode clears offline, so each leg carries its OWN replay nonce (the buyer
  // echoes it back, we consume it). Gateway mode needs none — the deposit-backed
  // settle is the replay guard. Mutates each leg's requirements in place (leg 0 is
  // `requirements`, so the returned value keeps its nonce, as before).
  if (cfg.PAYMENT_MODE === "mock") {
    for (const leg of legs) {
      leg.requirements.extra = { ...leg.requirements.extra, nonce: issueNonce(bindingOf(leg.requirements), now) };
    }
  }

  const paymentRequired: Record<string, unknown> = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      // Publisher-neutral: this gate is multi-tenant, so the 402 a buyer sees must
      // NOT name any one publisher's brand (it would be wrong for every other tenant
      // and leak the reference publisher). `naulon` names the toll PROTOCOL, not a
      // tenant; the article itself is identified by `resourceUrl` + the title.
      description: `naulon ${quote.kind} toll: ${quote.title}`,
      mimeType: "text/html",
    },
    // Stock x402: `accepts[]` is a list of ALTERNATIVES ("pick one"), not
    // simultaneous legs. The primary author leg stays here unchanged so a non-naulon
    // x402 client sees a valid single-option 402 and degrades to single-leg.
    accepts: [requirements],
  };
  // Simultaneous extra legs (co-author splits and/or `extraLegs`) are a naulon
  // extension. A plain single-author quote has only the author leg → omit it ENTIRELY
  // so the 402 is byte-identical to the stock shape (golden test). Key off the
  // ASSEMBLED legs, not `quote.extraLegs`: co-author legs are built here, not on the quote.
  if (legs.length > 1) {
    paymentRequired.extensions = {
      naulonLegs: {
        version: 1,
        settlement: "author-sync-rest-deferred",
        // Full leg list (author first): the buyer signs one authorization per entry
        // and sends them as an array in leg order. The gate uses its OWN `legs` for
        // verify/settle — never the wire — so a tampered wire can't change amounts.
        legs: legs.map((l) => ({
          role: l.role,
          payTo: l.requirements.payTo,
          amount: l.requirements.amount,
          ...(cfg.PAYMENT_MODE === "mock" ? { nonce: l.requirements.extra.nonce } : {}),
        })),
      },
    };
  }

  return { requirements, legs, header: Buffer.from(JSON.stringify(paymentRequired)).toString("base64") };
}
