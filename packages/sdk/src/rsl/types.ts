/**
 * RSL 1.0 — the shapes a CONSUMER reads. The mirror of the emitter a hosted control plane built on
 * this core already runs.
 *
 * The standard (spec 2025-12-10, namespace `https://rslstandard.org/rsl`) is how a publisher says,
 * machine-readably, what an automated client may do with a page and what it costs. naulon already
 * enforces and settles exactly those terms and has DECLARED them since 2026-08-24; this is the
 * other half of the wire — reading someone else's declaration, including a publisher who has never
 * heard of naulon.
 *
 * Two properties this module is built around:
 *
 *  - **A licence is a CLAIM, never an authority on price.** The 402 is the truth (the same rule
 *    `Candidate.priceUsdc` carries in wayfarer). Terms are read to decide whether to bother, to
 *    budget, and to know what the read may be USED for — never to settle from.
 *  - **Every field is optional in the wild.** Publishers hand-write these. A parser that throws on
 *    a missing `<amount>` reads as "this publisher has no terms", which is the one answer that is
 *    never true when a document exists. Absent ⇒ absent, and the caller decides.
 */

/** `<permits type="usage">` / `<prohibits type="usage">` — the RSL 1.0 usage vocabulary. */
export type RslUsage = "all" | "ai-all" | "ai-train" | "ai-input" | "ai-index" | "search";

/** `<permits type="user">` — who the grant is for. */
export type RslUserClass = "commercial" | "non-commercial" | "education" | "government" | "personal";

/**
 * `<payment type>` — RSL 1.0's payment vocabulary in full.
 *
 * `crawl` (per fetch) and `use` (per AI-generated output) are the two naulon emits, because they
 * are what a per-read toll and a per-citation toll actually are. `training` exists in the standard
 * and naulon deliberately never sells it.
 */
export type RslPaymentType =
  | "purchase"
  | "subscription"
  | "training"
  | "crawl"
  | "use"
  | "contribution"
  | "attribution"
  | "free";

/** `<accepts type="…">` — a payment protocol the publisher will take, with optional metadata. */
export interface RslAccepts {
  /** The media type identifying the protocol, e.g. `application/x402+json`. */
  type: string;
  /** The element body. naulon writes `{"scheme":"exact","network":"eip155:8453"}` in CDATA; other
   *  publishers write whatever their rail needs, or nothing. Never parsed here — a consumer that
   *  understands the protocol parses its own metadata. */
  meta?: string;
}

/** One `<payment>` block. */
export interface RslPayment {
  type: RslPaymentType;
  /** `<amount currency="ISO4217">` — the number as declared. `free` blocks carry none. */
  amount?: { value: number; currency: string };
  /** Every `<accepts>` on this payment, in document order. */
  accepts: RslAccepts[];
  /** `<standard>` — a shared licensing framework URL. */
  standard?: string;
  /** `<custom>` — a publisher-specific licensing endpoint URL. */
  custom?: string;
}

/** The three axes `<permits>`/`<prohibits>` can constrain, each a set of tokens. */
export interface RslConstraints {
  usage: RslUsage[];
  user: RslUserClass[];
  /** ISO 3166-1 alpha-2 country/region codes. */
  geo: string[];
}

/** One `<license>` block inside a `<content>` scope. */
export interface RslLicense {
  permits: RslConstraints;
  prohibits: RslConstraints;
  /** Zero or one `<payment>`. Absent ⇒ the block grants without stating a price, which is not the
   *  same as free — `free` is a payment type a publisher states deliberately. */
  payment?: RslPayment;
  /** `<legal type="contact">` — how to reach a human about this licence. */
  contact?: string;
  /** `<terms>` — URL of the human-readable terms of service. */
  termsUrl?: string;
}

/** One `<content>` scope and its licences. */
export interface RslContent {
  /**
   * `content@url` — an RFC 9309 path pattern (`*`, `$`), an absolute URL, or `""` when the scope
   * comes from the association mechanism (inline HTML, an RSS `<item>`).
   */
  url: string;
  /**
   * `content@server` — an OLP (Open Licensing Protocol) licence server.
   *
   * LOAD-BEARING, and the reason a consumer cannot ignore it: the spec says a client MUST obtain a
   * licence from this server *regardless of the payment type, including `free`*. So a scope with a
   * server is not payable from the inline terms, whatever those terms say. `licenceObligation`
   * turns that into the one refusal a caller has to honour.
   */
  server?: string;
  encrypted?: boolean;
  /** RFC 3339. */
  lastmod?: string;
  licenses: RslLicense[];
}

/** A parsed RSL document. */
export interface RslDocument {
  contents: RslContent[];
}
