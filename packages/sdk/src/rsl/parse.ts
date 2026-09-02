/**
 * Parse an RSL 1.0 document into `RslDocument`.
 *
 * Reads through `crawl/xml.ts` — the one configured `fast-xml-parser` in this package — rather than
 * standing up a second parser with its own settings. That module's config is already the right one
 * here: attributes surface under `@_` (RSL puts `url`, `server`, `type`, `currency` in attributes),
 * CDATA folds into the tag value (naulon's own `<accepts>` metadata is CDATA), and tag values stay
 * strings (a `<amount>` of `0.10` must not become `0.1` before we have seen it).
 *
 * ## Namespace prefixes
 *
 * The same document is legal three ways: default namespace (`<content>`), an explicit prefix
 * (`<rsl:content>`), or a different prefix entirely — the prefix is the author's choice, only the
 * namespace URI is fixed. fast-xml-parser keeps prefixes verbatim, so every lookup goes through
 * `pick`, which matches a local name with or without any prefix. A parser that hard-coded `content`
 * would silently read an empty document from a `<rsl:rsl>` file, which is exactly the shape the
 * spec's own RSS and media-embedding examples use.
 *
 * ## What this deliberately does not do
 *
 * No validation, no throwing on a missing child. A hand-written licence with no `<amount>` is a
 * real document that says something ("permitted, price unstated"), and refusing it would report the
 * publisher as having no terms — the one answer that cannot be true when a document exists. The
 * caller decides what an absent field means; `terms.ts` is where that judgement lives.
 *
 * ## Safety
 *
 * `fast-xml-parser` REFUSES a DTD that declares an external entity — it throws
 * `External entities are not supported` rather than resolving it — so the XXE and billion-laughs
 * classes fail closed here, and `parseRslOrNull` turns that into "no licence". The remaining
 * hostile inputs are size and depth, and those are bounded by the FETCHER (`locate.ts` caps the
 * body), not by the parser: a string already in memory is already the cost.
 */
import { parseXml, toArray, textOf } from "../crawl/xml.ts";
import type {
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

/** RSL 1.0's usage vocabulary. A token outside it is dropped, not guessed at. */
const USAGE = new Set<string>(["all", "ai-all", "ai-train", "ai-input", "ai-index", "search"]);
const USER = new Set<string>(["commercial", "non-commercial", "education", "government", "personal"]);
const PAYMENT = new Set<string>([
  "purchase",
  "subscription",
  "training",
  "crawl",
  "use",
  "contribution",
  "attribution",
  "free",
]);

/** Read `name` from a parsed node, with or without a namespace prefix (`rsl:name`, `x:name`). */
function pick(node: Record<string, unknown>, name: string): unknown {
  if (name in node) return node[name];
  const suffix = `:${name}`;
  for (const key of Object.keys(node)) {
    if (key.endsWith(suffix)) return node[key];
  }
  return undefined;
}

/** A node's attribute, whatever prefix its element carried. Attributes are never prefixed here —
 *  RSL puts none of them in a namespace — so this is a plain read with the `@_` convention. */
function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return typeof v === "string" ? v : undefined;
}

/** Every element child under `name`, normalized to an array (fast-xml-parser gives one or many). */
function children(node: Record<string, unknown>, name: string): Record<string, unknown>[] {
  return toArray(pick(node, name) as unknown).filter(
    (c): c is Record<string, unknown> => typeof c === "object" && c !== null,
  );
}

/**
 * Split an element body into tokens.
 *
 * RSL states multiple values space-separated inside one element (`ai-input ai-index`). Some
 * publishers write them comma-separated instead; accepting both costs one character class and
 * removes a whole class of "we read their licence as granting nothing".
 */
function tokens(node: unknown): string[] {
  return textOf(node)
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Collect `<permits>` or `<prohibits>` into the three constrained axes. */
function constraints(license: Record<string, unknown>, element: "permits" | "prohibits"): RslConstraints {
  const out: RslConstraints = { usage: [], user: [], geo: [] };
  for (const raw of toArray(pick(license, element) as unknown)) {
    // A bare `<permits>usage-token</permits>` with no `type` is `usage` — the spec's default axis
    // and, in practice, what a hand-written licence looks like.
    const type = attr(raw, "type") ?? "usage";
    for (const t of tokens(raw)) {
      if (type === "usage" && USAGE.has(t)) out.usage.push(t as RslUsage);
      else if (type === "user" && USER.has(t)) out.user.push(t as RslUserClass);
      // Geo is an open ISO 3166-1 alpha-2 set; validate the SHAPE, never a country list that would
      // rot the first time a code is added.
      else if (type === "geo" && /^[A-Za-z]{2}$/.test(t)) out.geo.push(t.toUpperCase());
    }
  }
  return out;
}

/** One `<payment>` block, or undefined when the licence states none. */
function payment(license: Record<string, unknown>): RslPayment | undefined {
  const raw = toArray(pick(license, "payment") as unknown)[0];
  if (!raw || typeof raw !== "object") return undefined;
  const node = raw as Record<string, unknown>;
  const type = attr(node, "type");
  // An unrecognized payment type is NOT dropped to `free` — that would read a licence we do not
  // understand as a licence that costs nothing, which is the most expensive possible default.
  if (!type || !PAYMENT.has(type)) return undefined;

  const accepts: RslAccepts[] = [];
  for (const a of toArray(pick(node, "accepts") as unknown)) {
    const t = attr(a, "type");
    if (!t) continue;
    const meta = textOf(a);
    accepts.push(meta ? { type: t, meta } : { type: t });
  }

  const amountNode = toArray(pick(node, "amount") as unknown)[0];
  const amountText = textOf(amountNode);
  const value = amountText === "" ? Number.NaN : Number(amountText);
  const currency = attr(amountNode, "currency");

  const standard = textOf(toArray(pick(node, "standard") as unknown)[0]);
  const custom = textOf(toArray(pick(node, "custom") as unknown)[0]);

  return {
    type: type as RslPaymentType,
    // A non-numeric or negative amount is dropped rather than coerced: `<amount>ask us</amount>`
    // must not become 0, which would price a paid licence at free.
    ...(Number.isFinite(value) && value >= 0 && currency ? { amount: { value, currency } } : {}),
    accepts,
    ...(standard ? { standard } : {}),
    ...(custom ? { custom } : {}),
  };
}

/** `<legal type="contact">` — the one legal axis a consumer acts on (who to ask). */
function contactOf(license: Record<string, unknown>): string | undefined {
  for (const raw of toArray(pick(license, "legal") as unknown)) {
    if (attr(raw, "type") === "contact") {
      const v = textOf(raw);
      if (v) return v;
    }
  }
  return undefined;
}

function licenseOf(node: Record<string, unknown>): RslLicense {
  const termsUrl = textOf(toArray(pick(node, "terms") as unknown)[0]);
  const contact = contactOf(node);
  const pay = payment(node);
  return {
    permits: constraints(node, "permits"),
    prohibits: constraints(node, "prohibits"),
    ...(pay ? { payment: pay } : {}),
    ...(contact ? { contact } : {}),
    ...(termsUrl ? { termsUrl } : {}),
  };
}

function contentOf(node: Record<string, unknown>): RslContent {
  const server = attr(node, "server");
  const lastmod = attr(node, "lastmod");
  return {
    // `url` is REQUIRED by the spec but may be empty (association scope). Absent is treated as
    // empty for the same reason — `terms.ts` resolves an empty scope against the document's own
    // location instead of guessing a pattern.
    url: attr(node, "url") ?? "",
    ...(server ? { server } : {}),
    ...(attr(node, "encrypted") === "true" ? { encrypted: true } : {}),
    ...(lastmod ? { lastmod } : {}),
    licenses: children(node, "license").map(licenseOf),
  };
}

/**
 * Parse an RSL document.
 *
 * Accepts the standalone form (`<rsl><content>…`) and the embedded form the spec uses inside feeds
 * and media metadata (`<rsl:rsl>` / `rsl:content` under some other root). Returns an empty
 * `contents` for anything that is not RSL — including well-formed XML that simply is not a licence,
 * which is what a publisher's 404 page or sitemap looks like when a locator guessed wrong.
 *
 * Throws when the input is not XML at all, and when it carries a DTD declaring an external entity
 * (the parser refuses those outright). A caller treating a throw as "no licence" is correct — which
 * is what `parseRslOrNull` does, so nobody has to remember to.
 */
export function parseRsl(xml: string): RslDocument {
  const doc = parseXml(xml);
  const root = pick(doc, "rsl");
  const node = (Array.isArray(root) ? root[0] : root) as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") return { contents: [] };
  return { contents: children(node, "content").map(contentOf) };
}

/**
 * `parseRsl` that answers null instead of throwing.
 *
 * Every real consumer wants this one: a licence that will not parse is a licence you do not have,
 * and there is nothing else to do about it. It exists so the decision is made ONCE here rather than
 * in each of the three call sites, one of which would eventually forget the try/catch and take down
 * an agent run over a publisher's malformed XML.
 */
export function parseRslOrNull(xml: string): RslDocument | null {
  try {
    const doc = parseRsl(xml);
    return doc.contents.length > 0 ? doc : null;
  } catch {
    return null;
  }
}
