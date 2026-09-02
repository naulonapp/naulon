/**
 * Resolve a document to the terms that apply to ONE url — the question a buying agent actually
 * asks: may I use this, what does it cost, and who do I pay?
 *
 * ## Precedence is per-QUESTION, not per-document
 *
 * RSL says "more specific declarations, such as those with narrower asset scope … MUST take
 * precedence over less specific declarations", and states no algorithm. The obvious reading —
 * pick the single most specific `<content>` and ignore the rest — is wrong in a way that costs a
 * publisher money. A very common document says "search is free" once at `/` and prices
 * `/articles/*`; winner-takes-all would read an article as having no search grant at all, and a
 * search crawler would either refuse a page it is welcome to index or pay for it.
 *
 * So each question is answered by the most specific scope that SPEAKS to it. A narrower scope
 * overrides a broader one on the tokens it mentions, and stays silent on the ones it does not.
 * Within one scope, `<prohibits>` beats `<permits>` — that rule the spec does state outright.
 *
 * ## What is deliberately NOT decided here
 *
 * Whether to pay. This module reports; `decide()` in the agent judges. The one thing it will not
 * do is round a licence it does not understand toward "free" or "permitted" — every unknown
 * resolves to the conservative answer, because the failure mode on the other side is taking a
 * publisher's work without paying them for it.
 */
import { matchesPattern, specificity } from "./pattern.ts";
import type { RslContent, RslDocument, RslPaymentType, RslUsage } from "./types.ts";

/** A priced (or explicitly free) offer that grants the usage asked for. */
export interface RslOffer {
  /** `free` ⇒ granted at no cost. Anything else carries `amount` when the publisher stated one. */
  paymentType: RslPaymentType;
  /** Absent when the publisher priced nothing (e.g. `<payment type="crawl"/>` with no `<amount>`,
   *  or an amount we refused to coerce). "Priced, number unstated" is a real answer. */
  amount?: { value: number; currency: string };
  /** The `<accepts>` media types on this payment, e.g. `application/x402+json`. */
  accepts: { type: string; meta?: string }[];
  /** The `<content url>` this offer came from — the audit trail for why this price applied. */
  scope: string;
  /** The source of the `<license>` this offer came from. What OLP's `/token` wants, verbatim. */
  licenseXml?: string;
}

/** How a client is allowed to obtain the licence. */
export type RslObligation =
  /** The document's own terms are the licence. Pay per the offer. */
  | "inline"
  /**
   * The winning scope names an OLP licence server, so the spec REQUIRES a client to obtain the
   * licence there — "regardless of the payment `type`, including when `type="free"`". Inline terms
   * are then advertising, not authority, and an agent that pays from them has not licensed
   * anything. naulon does not speak OLP, so this is a refusal, not a price.
   */
  | "license-server";

export interface RslTermsForUrl {
  /** Every `<content url>` that matched, most specific first — the evidence for everything below. */
  scopes: string[];
  /** Per-usage verdict. `undefined` = the document says nothing, which is NOT permission. */
  usage: Partial<Record<RslUsage, boolean>>;
  /** The offer covering `ai-input` — a read the agent may ground an answer in. */
  read?: RslOffer;
  obligation: RslObligation;
  /** The OLP server, when `obligation` is `license-server`. */
  server?: string;
  /** `<legal type="contact">` from the winning scope, for a human follow-up. */
  contact?: string;
}

/** The applicable scopes, most specific first, ties broken by document order (later wins). */
function applicable(doc: RslDocument, path: string, associationPath?: string): RslContent[] {
  return doc.contents
    .map((c, i) => ({ c, i }))
    .filter(({ c }) =>
      // An empty `url` is association-scoped: it means "the resource this document was found on".
      // Only the locator knows what that was, so a caller that did not say is not given a match —
      // guessing "the whole site" here would apply one page's terms to every page.
      c.url === "" ? associationPath !== undefined && associationPath === path : matchesPattern(c.url, path),
    )
    .sort((a, b) => specificity(b.c.url) - specificity(a.c.url) || b.i - a.i)
    .map(({ c }) => c);
}

/**
 * `ai-all` and `all` are umbrellas. A licence permitting `ai-all` permits `ai-input`; one
 * prohibiting `all` prohibits everything. Expanding them here is what stops a document that grants
 * `ai-all` from reading as "says nothing about ai-input".
 */
const UMBRELLA: Record<string, RslUsage[]> = {
  all: ["ai-all", "ai-train", "ai-input", "ai-index", "search"],
  "ai-all": ["ai-train", "ai-input", "ai-index"],
};

/**
 * Does a declared usage set grant `token`, umbrellas included?
 *
 * Exported because "is this licence about ai-input?" is asked outside the per-URL resolution too —
 * by anything auditing a whole document rather than one address. A second copy of the umbrella
 * table is how `ai-all` ends up granting `ai-input` in one place and not the other.
 */
export function grantsUsage(declared: readonly RslUsage[], token: RslUsage): boolean {
  return covers(declared as RslUsage[], token);
}

function covers(declared: RslUsage[], token: RslUsage): boolean {
  if (declared.includes(token)) return true;
  return declared.some((d) => UMBRELLA[d]?.includes(token) ?? false);
}

/** The verdict on one usage token, from the most specific scope that speaks to it. */
function verdict(scopes: RslContent[], token: RslUsage): boolean | undefined {
  for (const scope of scopes) {
    let permitted: boolean | undefined;
    for (const l of scope.licenses) {
      // Prohibition wins inside a scope — stated by the spec, and the safe direction anyway.
      if (covers(l.prohibits.usage, token)) return false;
      if (covers(l.permits.usage, token)) permitted = true;
    }
    // Silent scopes fall through to the broader one — that is what makes precedence per-question.
    if (permitted !== undefined) return permitted;
  }
  return undefined;
}

/**
 * The offer for `ai-input`, from the most specific scope that both grants it and states a payment.
 *
 * Free-first within a scope: naulon's own document (and most others) put the free grant before the
 * priced one, and a client that finds a free grant covering what it wants must not then pay for it.
 */
function readOffer(scopes: RslContent[]): { offer: RslOffer; scope: RslContent } | undefined {
  for (const scope of scopes) {
    // `l.payment` is required here: a narrow scope that grants `ai-input` and says nothing about
    // price is silent on price, so the broader scope's number still applies. Treating silence as
    // free is the one reading that takes the work without paying for it.
    const granting = scope.licenses.filter((l) => l.payment && covers(l.permits.usage, "ai-input"));
    if (granting.length === 0) continue;
    const free = granting.find((l) => l.payment!.type === "free");
    const chosen = free ?? granting[0]!;
    const p = chosen.payment!;
    return {
      offer: {
        paymentType: p.type,
        ...(p.amount ? { amount: p.amount } : {}),
        accepts: p.accepts,
        scope: scope.url,
        ...(chosen.raw ? { licenseXml: chosen.raw } : {}),
      },
      scope,
    };
  }
  return undefined;
}

/**
 * Resolve `url` against a parsed document.
 *
 * `url` may be absolute or a path; only its pathname is matched, because `content@url` is an
 * RFC 9309 path pattern and matching a full URL would let a crafted path segment satisfy another
 * origin's pattern. The caller has already established that this document governs this origin.
 */
export function termsForUrl(
  doc: RslDocument,
  url: string,
  opts: { associationPath?: string } = {},
): RslTermsForUrl | null {
  let path: string;
  try {
    path = url.startsWith("/") ? url : new URL(url).pathname;
  } catch {
    return null;
  }
  const scopes = applicable(doc, path, opts.associationPath);
  if (scopes.length === 0) return null;

  const found = readOffer(scopes);
  // The obligation attaches to the `<content>` whose licence we would rely on — the spec words it
  // as "the PARENT `<content>` element". With no offer to rely on, the most specific matching scope
  // is the one that governs, so its server still binds.
  const governing = found?.scope ?? scopes[0]!;
  const usage: Partial<Record<RslUsage, boolean>> = {};
  for (const token of ["ai-input", "ai-index", "ai-train", "search", "ai-all", "all"] as RslUsage[]) {
    const v = verdict(scopes, token);
    if (v !== undefined) usage[token] = v;
  }
  const contact = governing.licenses.find((l) => l.contact)?.contact;

  return {
    scopes: scopes.map((s) => s.url),
    usage,
    ...(found ? { read: found.offer } : {}),
    obligation: governing.server ? "license-server" : "inline",
    ...(governing.server ? { server: governing.server } : {}),
    ...(contact ? { contact } : {}),
  };
}

/** The x402 media type RSL carries a naulon-payable offer under. */
export const X402_MEDIA_TYPE = "application/x402+json";

/**
 * Is this read payable over x402, and on what rail?
 *
 * `<accepts>`'s body is optional protocol metadata; naulon writes `{"scheme","network"}` and other
 * publishers write whatever they write. A missing or unparseable body still means x402 is accepted
 * — the agent will learn scheme and chain from the 402 itself — so this reports `{}` rather than
 * null. Only the ABSENCE of an x402 `<accepts>` is a null, because that is the publisher saying
 * they take some other rail.
 */
export function x402Offer(terms: RslTermsForUrl): { scheme?: string; network?: string } | null {
  const accepts = terms.read?.accepts.find((a) => a.type.toLowerCase() === X402_MEDIA_TYPE);
  if (!accepts) return null;
  if (!accepts.meta) return {};
  try {
    const meta = JSON.parse(accepts.meta) as Record<string, unknown>;
    return {
      ...(typeof meta["scheme"] === "string" ? { scheme: meta["scheme"] } : {}),
      ...(typeof meta["network"] === "string" ? { network: meta["network"] } : {}),
    };
  } catch {
    return {};
  }
}
