/**
 * The body on a 402 — one builder, both emitters (the hosted gate and the in-app
 * middleware).
 *
 * WHY THIS EXISTS: until now a naulon 402 was ZERO BYTES. Everything a buyer needed
 * rode in `PAYMENT-REQUIRED`, which is correct for an x402 client and useless to
 * everyone else — a crawler that does not speak x402 got a blank refusal with no
 * price, no terms and no way to find either. Measured on the one live tenant
 * 2026-09-03: `402`, no body, no `crawler-price`.
 *
 * THE SHAPE IS DELIBERATELY SOMEONE ELSE'S. `@crawlertoll/core` — the Apache-2.0
 * vendor-neutral middleware that sits under Cloudflare PPC / TollBit / Skyfire /
 * Stripe ACP — answers a toll with `{error, message, offer}` and documents "the body
 * is the source of truth; the headers are the on-the-wire convenience". Mirroring its
 * `PaymentOffer` field-for-field means a buyer written against THAT library prices a
 * naulon origin with no naulon code, which is the whole point of speaking a rail we
 * did not invent. naulon specifics live under `offer.metadata`, which is exactly what
 * that field is for ("custom fields the rail wants to surface").
 *
 * WHAT IT IS NOT: the authoritative payment payload. That stays in `PAYMENT-REQUIRED`
 * — signed, nonce-bound, per-leg. The body advertises; the header obligates. A client
 * that pays from the body alone has not been given enough to pay, by design.
 *
 * Money is integer micro-USDC throughout, as everywhere else in this repo.
 */
import { formatCrawlerPrice } from "./crawlerPrice.ts";
import { X402_MANIFEST_PATH } from "./discoverability.ts";
import type { TollKind } from "@naulon/shared";

/** `Number` is exact for every integer below 2^53; a toll is micro-USDC and nowhere near
 *  it. Guarded rather than assumed, because a silently-rounded price is a lie about money. */
const MAX_SAFE_MICRO = BigInt(Number.MAX_SAFE_INTEGER);

/** The rail name CrawlerToll already knows us to settle on. We are an x402 origin; the
 *  naulon-specific detail (legs, proof, license) is in `metadata`, not a new rail word. */
const RAIL = "x402";

export interface PaymentOfferMetadata {
  /** `read` or `citation` — the two things a naulon toll sells. */
  tollKind: TollKind;
  /** The header carrying the signed, nonce-bound requirements. Named so a reader of the
   *  body knows where the real obligation is without guessing. */
  paymentRequiredHeader: "PAYMENT-REQUIRED";
  /** The toll manifest: prices, scope, networks, where a license is verified. */
  manifest: string;
  /** The same figure as the `crawler-price` header, verbatim, so a body-only reader and a
   *  header-only reader can never disagree about the ask. */
  crawlerPrice: string;
  /** Humans are never charged. Stated in the payload because a machine reading a refusal
   *  cannot see the classifier that produced it. */
  humansReadFree: true;
}

export interface PaymentOffer {
  rail: typeof RAIL;
  priceMicros: number;
  /** What actually moves on the wire. The `crawler-price` header says `USD` because that
   *  is the vocabulary Cloudflare taught crawlers; the settlement asset is USDC, 1:1. */
  currency: "USDC";
  publisher: string;
  endpoint: string;
  metadata: PaymentOfferMetadata;
}

export interface PaymentRequiredBody {
  error: "payment_required";
  message: string;
  offer: PaymentOffer;
}

export interface PaymentBodyInput {
  /** The full ask, summed across every settlement leg (`totalChargedMicro`). */
  askMicro: bigint;
  /** The host being tolled — the publisher identifier a buyer would name. */
  publisher: string;
  /** The path being tolled. */
  endpoint: string;
  tollKind: TollKind;
}

/** Content type for every 402 body this builds. */
export const PAYMENT_BODY_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * The advertisement a 402 carries. Pure — no config read, no clock, no network — so both
 * emitters can call it on their hot path.
 */
export function paymentRequiredBody(input: PaymentBodyInput): PaymentRequiredBody {
  const { askMicro, publisher, endpoint, tollKind } = input;
  if (askMicro < 0n) throw new Error(`invalid ask: ${askMicro}`);
  if (askMicro > MAX_SAFE_MICRO) throw new Error(`ask exceeds exact integer range: ${askMicro}`);

  const crawlerPrice = formatCrawlerPrice(askMicro);
  const what = tollKind === "citation" ? "cite" : "read";

  return {
    error: "payment_required",
    message:
      `This request was classified as an automated agent, and this resource is tolled. ` +
      `Humans read free. To ${what} it, pay ${crawlerPrice} over x402 in USDC: the signed ` +
      `payment requirements are in the PAYMENT-REQUIRED response header, and ${X402_MANIFEST_PATH} ` +
      `on this host describes the terms. Payment settles buyer-to-author directly; nobody ` +
      `custodies it in between.`,
    offer: {
      rail: RAIL,
      priceMicros: Number(askMicro),
      currency: "USDC",
      publisher,
      endpoint,
      metadata: {
        tollKind,
        paymentRequiredHeader: "PAYMENT-REQUIRED",
        manifest: X402_MANIFEST_PATH,
        crawlerPrice,
        humansReadFree: true,
      },
    },
  };
}

/** The same body, serialized. Two spaces, because a person reads this in a terminal at
 *  least as often as a machine parses it. */
export function paymentRequiredBodyText(input: PaymentBodyInput): string {
  return JSON.stringify(paymentRequiredBody(input), null, 2);
}
