/**
 * `@naulon/sdk/rsl` — reading RSL 1.0, the open content-licensing standard.
 *
 * A naulon deployment has DECLARED its publishers' terms in RSL since 2026-08-24. This subpath is
 * the other direction: reading anyone's declaration,
 * including a publisher who has never heard of naulon. That asymmetry is the point — the standard
 * is where the publishers already are (~1,500 orgs), and an agent that can read it can decide, and
 * pay, on the open web rather than only inside one fleet.
 *
 * Three layers, each usable alone:
 *   `locateLicence` — find the document (robots.txt · Link header · HTML link · inline).
 *   `parseRsl`      — XML → `RslDocument`.
 *   `termsForUrl`   — document + url → what is permitted, at what price, from whom.
 *
 * `licenceFor` is the three in one call, which is what a buying agent wants.
 */
export type {
  RslAccepts,
  RslConstraints,
  RslContent,
  RslDocument,
  RslLicense,
  RslPayment,
  RslPaymentType,
  RslUsage,
  RslUserClass,
} from "./types.ts";
export { parseRsl, parseRslOrNull } from "./parse.ts";
export { rawLicensesByContent } from "./raw.ts";
// The Open Licensing Protocol — how the obligation `terms.ts` reports is actually discharged.
export { acquireLicenseToken, olpRetryable, tokenEndpoint } from "./olp.ts";
export type { OlpCredentials, OlpFailure, OlpFailureCode, OlpResult, OlpToken } from "./olp.ts";
export { matchesPattern, specificity } from "./pattern.ts";
export { grantsUsage, termsForUrl, x402Offer, X402_MEDIA_TYPE } from "./terms.ts";
export type { RslObligation, RslOffer, RslTermsForUrl } from "./terms.ts";
export {
  inlineRslFromHtml,
  licenseUrlFromHtml,
  licenseUrlFromLinkHeader,
  licenseUrlFromRobots,
  locateFromObserved,
  locateFromRobots,
  locateLicence,
} from "./locate.ts";
export type { LocatedLicence, LocateOptions, ObservedResponse, RslSource } from "./locate.ts";

import { locateLicence, type LocateOptions, type RslSource } from "./locate.ts";
import { termsForUrl, type RslTermsForUrl } from "./terms.ts";

/** What a caller gets back: the terms, and the evidence for where they came from. */
export interface LicenceForUrl {
  terms: RslTermsForUrl;
  source: RslSource;
  documentUrl?: string;
}

/**
 * Find and resolve the terms governing one URL, in one call.
 *
 * Null means the publisher declares nothing that covers this URL. That is the common case today and
 * it is NOT permission — an agent's own policy decides what to do with an undeclared page, exactly
 * as it did before RSL existed.
 */
export async function licenceFor(url: string, opts: LocateOptions = {}): Promise<LicenceForUrl | null> {
  const located = await locateLicence(url, opts);
  if (!located) return null;
  const terms = termsForUrl(located.doc, url, { associationPath: located.associationPath });
  if (!terms) return null;
  return {
    terms,
    source: located.source,
    ...(located.documentUrl ? { documentUrl: located.documentUrl } : {}),
  };
}
