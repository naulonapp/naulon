/**
 * The licence-authority seam: how the gate charges a read presented with an RSL
 * licence token (`Authorization: License <token>`, RSL Open Licence Protocol)
 * instead of an x402 payment signed at request time.
 *
 * The gate does not know who issued the token or whose wallet stands behind it.
 * It hands the authority the 402 it would have answered with; the authority
 * either refuses, says the reader already holds a live licence for this URL, or
 * returns an x402 payment for exactly those legs. The gate then settles that
 * payment through the same path a buyer-signed payment takes, and reports the
 * outcome back so the authority can release or keep what it reserved.
 */

import type { TollKind } from "./types.ts";

/** The HTTP authentication scheme RSL assigns to a licence token. */
export const LICENCE_AUTH_SCHEME = "License";

/**
 * The token from an `Authorization: License <token>` header, or null. The scheme
 * is case-insensitive (RFC 7235). A token containing whitespace is refused
 * rather than truncated, so a malformed header can never name a shorter token.
 */
export function parseLicenceAuthorization(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^license[ ]+(\S+)$/i.exec(value.trim());
  return m ? m[1]! : null;
}

/** What saw the read: the gate that served the bytes, or the crawler's own signature on it. */
export type LicenceWitness = "gate" | "crawler-signed";

/** Stamped on a record charged under a standing authorization rather than signed at request time. */
export interface EventMandate {
  kind: "olp";
  tokenId: string;
  witness: LicenceWitness;
}

/** A verified Web Bot Auth signature on the request, as the gate's verifier saw it. */
export interface LicenceSigner {
  keyid: string;
  /** The covered components, in signature order, e.g. `["@authority", "@path"]`. */
  covers: string[];
  created?: number;
  expires?: number;
  /** The verified signature bytes, base64. What an authority keys one charge per signature on: the
   *  header's text can be relabelled and still verify, these bytes cannot. */
  signature?: string;
}

export interface LicenceAuthorizeRequest {
  token: string;
  publisherId: string;
  host: string;
  /** Canonical absolute URL of the read, as the record will carry it. */
  resource: string;
  slug: string;
  tollKind: TollKind;
  /** The PAYMENT-REQUIRED header value (base64 JSON) the gate would have answered with. */
  header: string;
  /** The settlement legs of that 402, author leg first. Typed by the gate's enforce layer. */
  legs: readonly unknown[];
  /** Web Bot Auth outcome on THIS request, when verified. */
  signer?: LicenceSigner;
}

export type LicenceVerdict =
  | { ok: true; kind: "charge"; payment: string; grantId: string; mandate: EventMandate }
  | { ok: true; kind: "held"; mandate: EventMandate }
  | { ok: false; status: 401 | 402 | 403 | 503; error: string; description?: string };

/**
 * How a charge ended. `unpaid` means no money moved (refused at verify, or the
 * origin could not serve before the settle); `ambiguous` means it may have.
 */
export type LicenceReport =
  | { grantId: string; outcome: "settled"; licenseJws?: string; eventId: string }
  | { grantId: string; outcome: "unpaid" }
  | { grantId: string; outcome: "ambiguous" };

export interface LicenceAuthority {
  authorize(req: LicenceAuthorizeRequest): Promise<LicenceVerdict>;
  /** Never throws into the gate; a failure here must not change the response. */
  report(r: LicenceReport): Promise<void>;
}
