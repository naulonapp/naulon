/**
 * Emitting RSL — Really Simple Licensing — for a tolled site.
 *
 * RSL 1.0 (spec 2025-12-10, ~1,500 orgs incl. Cloudflare, Akamai, Creative Commons, AP, Vox) is the
 * open XML standard for saying, machine-readably, what an AI crawler may do with a page and what it
 * costs. naulon ENFORCES and SETTLES exactly those terms, and this module DECLARES them, so a
 * crawler that reads RSL sees the price before it pays.
 *
 * The complement is precise: RSL declares, naulon collects. A publisher on naulon can state their
 * price in the standard's own vocabulary and be paid for it over x402 in the same breath —
 * `<accepts type="application/x402+json"/>` is a first-class RSL payment method and it is literally
 * naulon's rail.
 *
 * ## What this emits, and what it deliberately does NOT
 *
 * Terms are derived from the publisher's configuration, never authored here. Three choices are load-bearing:
 *
 * 1. **`server` only when the owner asked for it, and only where something is sold.** The spec is
 *    explicit: *"If the parent `<content>` element defines a `server` attribute, clients MUST
 *    obtain a license from the License Server, regardless of the payment `type`, including when
 *    `type="free"`."* So naming one tells an RSL client to fetch a licence even to index. That is
 *    the owner's choice (`licenceServer`), off by default, and the licence server issues
 *    the free licence for nothing. The gate never asks for one: humans and search read free there
 *    whatever a crawler holds. Blocks that sell nothing (a free section, a static extension) never
 *    carry `server`, because nothing there needs a licence at all.
 *
 * 2. **Only what the toll actually grants is declared.** A read or a citation is INFERENCE-time use:
 *    `ai-input` (used to answer now) and `ai-index`. naulon does not sell training corpora, so
 *    `ai-train` appears in NO `<permits>`. It is also not `<prohibits>`ed — the publisher never
 *    asked for it to be forbidden, and taking a position on their behalf would be inventing policy. Per
 *    the spec, an absent `<permits>` is "not explicitly permitted", which is exactly the truth.
 *
 * 3. **Search is free and says so.** `<permits type="usage">search</permits>` + `<payment
 *    type="free"/>` mirrors the classifier's seoAllowlist. A publisher who tolls indexing
 *    disappears from search, and the gate has never allowed that; the declaration should not
 *    suggest otherwise.
 *
 * Deterministic by construction: the same record produces byte-identical XML, so a change in the
 * output is a change in the tenant, not in the serializer.
 */

import { resolvePriceRule, type PriceRule, type TollKind } from "@naulon/shared";
import { publisherPatterns } from "@naulon/sdk/rsl";
import { STATIC_EXTENSIONS } from "@naulon/sdk/slug";
import { blocksFor, type TermsPolicy } from "./terms-policy.ts";

/** The per-tenant facts a licence is derived from. A narrow projection of the publisher record rather
 *  than the record itself — this module has no business reading a settlement secret, and the
 *  narrow shape is what makes the whole thing testable from a literal. */
export interface RslTenantTerms {
  /** The host these terms are published for — the `<content>` scope's origin. */
  host: string;
  /** Path patterns the toll applies to (RFC 9309 rules, `*` and `$`). Empty ⇒ the whole site. */
  articlePrefixes: readonly string[];
  /**
   * How the gate scopes the toll — mirrored from `PublisherConfig.gateScope`.
   *
   * `{mode:"site"}` tolls EVERY path, so a document listing only `articlePrefixes` would understate
   * the terms of a whole-site publisher: a crawler reading it would believe `/about` is unlicensed
   * when the gate will charge for it. In site mode the priced scope is `/` and each free section
   * becomes a MORE SPECIFIC `<content>` block — which is exactly how RSL resolves an overlap
   * ("more specific declarations MUST take precedence"), so the file says what the gate does.
   *
   * `includeExtensions` is the same story one level down: site mode does NOT toll the static
   * extensions (`STATIC_EXTENSIONS`) unless the publisher claws one back, so the free-file blocks
   * are emitted from that set MINUS this one. Without it the document would price `/logo.png`.
   */
  gateScope?:
    | { mode: "prefixes"; depth?: "segment" | "rest" }
    | { mode: "site"; excludePrefixes: readonly string[]; includeExtensions?: readonly string[] };
  /**
   * The licence server a crawler must obtain licences from (`<content server>`), when the owner
   * named one. Absent ⇒ the document is exactly what it was before this field existed.
   *
   * This is the fleet's BASE; the document names `licenceServerFor(base, host)`. RSL makes
   * `content@url` a path and makes the client post that path verbatim as `resource`, so a server
   * shared by every site cannot tell which site a spec-following client means. The host in the
   * server URL is what says it.
   */
  licenceServer?: string;
  /** Price of ONE agent read, in USD. */
  priceUsdc: number;
  /** A citation costs this multiple of a read. Absent ⇒ 1. The citation (`use`) licence is emitted
   *  at every multiplier, so a buyer can ask a licence server for citation rights by name. */
  citationMultiplier?: number;
  /**
   * The per-path price overrides the gate resolves before `priceUsdc` — `PublisherConfig.priceRules`,
   * in the SAME normalised, most-specific-first order the gate reads them.
   *
   * Without them a rule pricing `/articles` at $0.10 on a site with a $0.03 base puts
   * `crawler-price: USD 0.10` on the wire while the licence advertises `0.03`/`0.06`. An RSL crawler
   * budgets from the licence, so it under-authorizes and the transaction it agreed to fails.
   *
   * RSL resolves this natively: a document MAY carry many `<content>` blocks and "more specific
   * declarations MUST take precedence" (RSL 1.0). So a rule becomes its own,
   * narrower `<content>` block at its own amount, rather than an average or a footnote.
   */
  priceRules?: readonly PriceRule[];
  /**
   * What a buyer actually pays for a toll listed at `priceUsdc` — the publisher's price PLUS every
   * additive leg the 402 will carry (today: the operator fee). Absent ⇒ the price is the total,
   * which is the fee-off case and every self-hosted gate.
   *
   * A function rather than a number because the fee is not a flat percentage: it has a floor and a
   * cap, so a citation's total is not a read's total times the multiplier. The caller supplies it
   * from the SAME hook the gate quotes with, so no fee formula is copied into this module.
   *
   * A licence's price is only useful if a buyer can transact at it. A document declaring `0.001`
   * for a toll the 402 charges `0.0011` at makes a crawler that budgets from the licence
   * under-authorize and meet a 402 it had already agreed to pay.
   */
  buyerTotalUsdc?: (priceUsdc: number, kind: TollKind) => number;
  /** Where a human can reach the publisher about licensing — the site itself, unless given. */
  contactUrl?: string;
  /** RFC 3339. Omitted rather than guessed when unknown. */
  lastmodIso?: string;
  /**
   * The CAIP-2 chain the toll settles on for this tenant (`eip155:5042002`), if known.
   *
   * Emitted as the `<accepts>` body, which RSL defines as optional protocol-specific metadata. It
   * is worth the bytes because it is the one fact an agent otherwise has to spend a 402 round trip
   * to learn — and it is the same value the gate's own quote carries, not a second source.
   *
   * Absent ⇒ a self-closing `<accepts>`. Still spec-legal (the body is OPTIONAL, the `type` is what
   * is required) but rslstandard.org's own validator, which admits it is non-normative, rejects the
   * empty element as "Must contain payment method information". A publisher checking their licence there should not be told it is broken.
   */
  x402Network?: string;
  /**
   * What the publisher declared they permit (`termsPolicy`).
   *
   * ABSENT means NOT STATED, and an unstated policy emits the three hardcoded blocks this module
   * carried before the field existed. That is not timidity: a default would be naulon stating a
   * position on a publisher's behalf, which is the error point 2 above already refuses to make for
   * `ai-train`. The set is derived in `terms-policy.ts`; this module owns only the money.
   */
  termsPolicy?: TermsPolicy;
}

/** How long (days) a client may treat the document as fresh. One day: the terms are derived from
 *  live config a publisher can change from a dashboard, and a week-long cache would keep an old
 *  price quotable long after they raised it. */
const MAX_AGE_DAYS = 1;

/** The five characters that must never reach an XML document raw. Attribute values and text both
 *  go through this — a host or a URL is publisher-controlled input, and the one thing worse than
 *  no licence document is one that does not parse. */
export function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A price as RSL wants it: a decimal string in the `<amount>` body, with `currency` as an
 * attribute. Six decimal places is the USDC atom — the same precision the toll actually charges, so
 * the declared price and the quoted price are the same number. That equality is the point of the
 * whole document and it is `buyerTotalUsdc`'s job to keep it: what is declared here is what the
 * buyer is asked to authorize, never the publisher's share of it.
 *
 * Trailing zeros are then trimmed, to a floor of two decimals. Both halves matter and an earlier
 * regex got the common case wrong: it only fired when exactly two decimals were significant, so
 * `0.001` — **the price BOTH production publishers charge** — rendered as `0.001000`. A licence is
 * read by people deciding whether to deal with you; a price written as a machine artefact is a
 * worse first impression than a rounded one. Two decimals is the floor because `0.1` reads as a
 * typo where `0.10` reads as ten cents.
 */
export function formatAmount(usdc: number): string {
  if (!Number.isFinite(usdc) || usdc < 0) return "0.00";
  const fixed = usdc.toFixed(6);
  const trimmed = fixed.replace(/0+$/, "");
  const [whole = "0", frac = ""] = trimmed.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/**
 * The `<content url>` patterns for a tenant.
 *
 * A prefix like `/articles` becomes `/articles/*` — RFC 9309 wildcards, the same grammar
 * robots.txt uses, which is what the spec points at. No prefixes means the toll applies site-wide,
 * which is `/` and NOT `/*`: `/` already matches everything under it in RFC 9309, and a publisher
 * reading their own licence should see the simpler of two equivalent statements.
 */
/**
 * The free-file `<content url>` patterns for a whole-site toll: every extension the gate serves
 * free, minus the ones this publisher opted in.
 *
 * `/*.css$` is RFC 9309, which RSL uses for `content@url` — `*` any sequence, `$` end of path. RSL
 * 1.0 resolves an overlap by "more specific declarations MUST take precedence"; the spec states no
 * specificity algorithm, so longest-match is convention rather than normative, and these patterns
 * are longer than the `/` they carve out of either way.
 *
 * Discovery surfaces (`/robots.txt`, a sitemap or feed at any depth) are ALSO free and are
 * deliberately not declared: the gate matches them by filename shape at any depth, and no RFC 9309
 * pattern reproduces that faithfully. An approximation would replace one wrong claim with another.
 */
export function freeFilePatterns(includeExtensions: readonly string[] = []): string[] {
  const opted = new Set(includeExtensions.map((e) => e.trim().toLowerCase().replace(/^\./, "")));
  return STATIC_EXTENSIONS.filter((ext) => !opted.has(ext)).map((ext) => `/*.${ext}$`);
}

export function contentPatterns(prefixes: readonly string[]): string[] {
  const cleaned = prefixes
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith("/") ? p : `/${p}`))
    .map((p) => p.replace(/\/+$/, ""))
    .map((p) => `${p}/*`);
  return cleaned.length > 0 ? [...new Set(cleaned)].sort() : ["/"];
}

/** One `<license>` block. Kept as data so the ordering and the set are visible in one place.
 *  Exported because `RslContentBlock` carries it to a renderer — a card reads the amounts off the
 *  same objects the XML is written from. */
export interface LicenseBlock {
  /** What this licence GRANTS. Empty on a refusal-only block, which emits no `<permits>` at all. */
  usage: string[];
  /** What this licence REFUSES. Within a scope a prohibition beats a permission, by the RSL spec's
   *  own rule and by the reader in `@naulon/sdk/rsl` (`verdict`), so the two never have to be
   *  reconciled here. Absent until a publisher states one: nothing is refused on their behalf. */
  prohibits?: string[];
  /** Absent on a refusal. A price for something that is not on sale is a claim nobody made, and
   *  the sibling parser reads a payment-less `<license>` correctly (`sdk/src/rsl/parse.ts`). */
  payment?: { type: string; amountUsdc?: number };
  /** `<legal type="contact">` — the publisher's own rights contact, on a licence that is granted
   *  by negotiation rather than by price. Theirs, never ours: naulon brokers and can mint the
   *  record for whatever deal lands, it is not the counterparty. */
  contact?: string;
  /** Carried per block rather than read from `terms` inside the renderer, so a block stays a
   *  complete description of one `<license>` and the renderer stays pure. */
  x402Network?: string;
}

/**
 * The licence set for one tenant, in the order they are emitted.
 *
 * Free-first is deliberate: a processor evaluating all applicable terms together should meet the
 * unpriced grant before the priced one, and a human reading the file should see "search is free"
 * before they see a number.
 */
export function licenseBlocks(terms: RslTenantTerms): LicenseBlock[] {
  return licenseBlocksAt(terms, terms.priceUsdc, terms.citationMultiplier ?? 1);
}

/**
 * The same licence set, at an ARBITRARY read price and multiplier — the shape a per-path rule needs.
 *
 * Split out of `licenseBlocks` rather than parameterised in place so the site-level export keeps its
 * one-argument signature and its meaning ("this tenant's terms"), while a `<content>` block for a
 * priced section can ask the identical question about a different number. Both go through the same
 * `buyerTotalUsdc`, so a rule's declared amount carries the operator fee exactly as the base does —
 * applied PER AMOUNT, never scaled from the base, because the fee has a floor and a cap.
 */
function licenseBlocksAt(terms: RslTenantTerms, priceUsdc: number, multiplier: number): LicenseBlock[] {
  // Every declared amount is a BUYER TOTAL — the publisher's price plus the additive legs the 402
  // carries. Applied per priced amount, never once and scaled, because the fee's floor and cap make
  // it non-proportional. Absent hook ⇒ identity, so a fee-off fleet emits the document unchanged.
  const total = (usd: number, kind: TollKind): number => terms.buyerTotalUsdc?.(usd, kind) ?? usd;
  // The set itself is decided by `blocksFor`, from what the publisher declared. This function owns
  // the MONEY (which price, at which multiplier, through which fee hook) and nothing else, so the
  // two questions — "what may they do" and "what does it cost" — have one owner each. An unstated
  // policy reproduces the hardcoded set this replaced, byte for byte.
  return blocksFor(terms.termsPolicy, {
    readUsdc: total(priceUsdc, "read"),
    citationUsdc: total(priceUsdc * multiplier, "citation"),
    ...(terms.x402Network ? { x402Network: terms.x402Network } : {}),
  });
}

/**
 * The `<accepts>` element. The body is the x402 quote's own vocabulary — `scheme` is always
 * `exact` (the only scheme the gate mints) and `network` is the chain this tenant settles on.
 *
 * CDATA rather than escaping, which is what the spec asks for inline protocol metadata, and it
 * keeps the JSON readable to a human reading the file.
 */
function renderAccepts(x402Network: string | undefined): string {
  if (!x402Network) return `        <accepts type="application/x402+json"/>`;
  const meta = JSON.stringify({ scheme: "exact", network: x402Network });
  return `        <accepts type="application/x402+json"><![CDATA[${meta}]]></accepts>`;
}

/** Serialize one `<license>`. */
/** One `<license>` element, exactly as the document renders it. Exported for the licence server,
 *  which answers `/introspect` with the licence a token stands for. */
export function renderLicense(b: LicenseBlock): string {
  const lines: string[] = ["    <license>"];
  // An empty `usage` is a refusal-only licence. Emitting `<permits type="usage"></permits>` for it
  // would be an empty grant, which a reader has to interpret; emitting nothing is the truth.
  if (b.usage.length > 0) lines.push(`      <permits type="usage">${escapeXml(b.usage.join(" "))}</permits>`);
  if (b.prohibits && b.prohibits.length > 0) {
    lines.push(`      <prohibits type="usage">${escapeXml(b.prohibits.join(" "))}</prohibits>`);
  }
  // `<legal type="contact">` is the one legal axis a consumer acts on, and the only licence that
  // carries one is a grant made by AGREEMENT — it is who to ask, so a licence with a price has no
  // use for it. Emitted last, after the payment, which is the order a reader needs it in.
  const legal = b.contact ? [`      <legal type="contact">${escapeXml(b.contact)}</legal>`] : [];
  if (!b.payment) return [...lines, ...legal, "    </license>"].join("\n");
  if (b.payment.type === "free") {
    return [...lines, `      <payment type="free"/>`, ...legal, "    </license>"].join("\n");
  }
  // A payment with no amount is a real offer, not a broken one: it is the shape of "granted, ask
  // the publisher". No `<amount>` invented for it and no `<accepts>` either, because nothing here is payable
  // on the rail — advertising x402 under it would promise a transaction that cannot happen.
  if (b.payment.amountUsdc === undefined) {
    return [...lines, `      <payment type="${escapeXml(b.payment.type)}"/>`, ...legal, "    </license>"].join("\n");
  }
  return [
    ...lines,
    `      <payment type="${escapeXml(b.payment.type)}">`,
    `        <amount currency="USD">${formatAmount(b.payment.amountUsdc ?? 0)}</amount>`,
    // The rail, declared in the standard's own vocabulary. A crawler that speaks x402 — which is
    // what naulon's 402 challenge IS — can pay this without a human ever being involved. The body
    // carries the scheme and chain when known, wrapped in CDATA as the spec asks, so an
    // agent can prepare a payment before it has ever seen the 402.
    renderAccepts(b.x402Network),
    "      </payment>",
    ...legal,
    "    </license>",
  ].join("\n");
}

/**
 * One `<content>` scope in the document, with the licences that apply to it.
 *
 * This is the document's OWN structure, not a description of it. `buildRslDocument` serializes
 * exactly this — see `rslContentBlocks` — so anything else that needs to state a publisher's terms
 * (a dashboard card, a docs page) renders the same array the XML was written from and cannot drift
 * from it.
 */
export interface RslContentBlock {
  /** The RFC 9309 pattern this scope covers, exactly as the `<content url>` attribute carries it. */
  pattern: string;
  /** The licences on this scope, in emission order (free-first). */
  licenses: LicenseBlock[];
}

/**
 * The document as data: every `<content>` scope, in the order it is emitted.
 *
 * The whole selection policy lives here and nowhere else — which rule governs a scope, which rules
 * are narrow enough to earn a block of their own, and which are dropped because the gate would never
 * reach them. A caller that renders this array is showing the document; a caller that re-derives it
 * from the publisher's configuration is guessing, which is precisely the drift this function exists to end.
 */
export function rslContentBlocks(terms: RslTenantTerms): RslContentBlock[] {
  const site = terms.gateScope?.mode === "site";
  // Agent-bound rules are not public terms: each prices one verified agent, and the document is
  // read by every agent. Publishing one here would offer its price to everybody.
  const rules = (terms.priceRules ?? []).filter((r) => r.agent === undefined);
  /**
   * Which rule governs a `<content url>` SCOPE, resolved with the gate's own matcher.
   *
   * The probe is the scope pattern with its trailing `/*` removed, because that is the path shape
   * the gate actually prices: a scope `/articles/*` is tolled at whatever rule wins for `/articles`,
   * and RFC 9309 prefix matching makes that the same rule that wins for every path beneath it. `/`
   * probes as `/`, which only a rule literally patterned `/` can win.
   */
  const governing = (pattern: string): PriceRule | undefined =>
    resolvePriceRule(rules, pattern === "/" ? "/" : pattern.replace(/\/\*$/, ""));
  /** A rule already spoken for by a scope block, so it is never emitted a second time. Identity, not
   *  pattern equality: two rules may legitimately share nothing but their subtree. */
  const claimed = new Set<PriceRule>();
  const licensesFor = (rule: PriceRule | undefined): LicenseBlock[] =>
    licenseBlocksAt(
      terms,
      rule?.priceUsdc ?? terms.priceUsdc,
      rule?.citationMultiplier ?? terms.citationMultiplier ?? 1,
    );
  const blocks: RslContentBlock[] = [];
  // Every pattern here is a PUBLISHER pattern (a price rule, a scope, a free-file carve-out), and
  // the gate prices it by `matchesPublisherPattern`: `/a$` is the article whatever its query. RFC
  // 9309 reads `/a$` literally and would tell a client that `/a?page=2` is outside it, so the
  // document states both literal patterns the publisher's one stands for, with the same terms.
  const contentBlock = (pattern: string, licenses: LicenseBlock[]): void => {
    for (const literal of publisherPatterns(pattern)) blocks.push({ pattern: literal, licenses });
  };

  // The FREE-only licence set, for a section the publisher carved out of a whole-site toll. It
  // permits what a paid section permits, at no cost — not merely `search`, because an excluded
  // section is not gated at all and an agent may read it the same way a person can.
  const freeOnly: LicenseBlock[] = [{ usage: ["search", "ai-input", "ai-index"], payment: { type: "free" } }];

  if (site) {
    const scope = terms.gateScope?.mode === "site" ? terms.gateScope : undefined;
    const base = governing("/");
    if (base) claimed.add(base);
    contentBlock("/", licensesFor(base));
    // Every remaining rule is, by construction, a narrower scope inside the site-wide one — that is
    // what a per-path rule IS — so each becomes its own `<content>` block at its own amount and RSL's
    // "more specific MUST take precedence" resolves the overlap. Emitted in the stored (already
    // most-specific-first) order, so the file reads the way the gate resolves.
    for (const rule of rules) {
      if (claimed.has(rule)) continue;
      contentBlock(rule.pattern, licensesFor(rule));
    }
    // More specific beats less specific, so these override the site-wide priced block for exactly
    // the paths the gate lets through free. Sorted for a stable document. LAST, because free is the
    // narrowest statement in the document and a reader should meet the carve-outs after the prices.
    for (const pattern of contentPatterns(scope?.excludePrefixes ?? [])) {
      if (pattern === "/") continue; // no exclusions ⇒ nothing to carve out
      contentBlock(pattern, freeOnly);
    }
    for (const pattern of freeFilePatterns(scope?.includeExtensions ?? [])) contentBlock(pattern, freeOnly);
  } else {
    const scopes = contentPatterns(terms.articlePrefixes);
    for (const pattern of scopes) {
      const rule = governing(pattern);
      if (rule) claimed.add(rule);
      contentBlock(pattern, licensesFor(rule));
    }
    // In prefixes mode a rule OUTSIDE every tolled section prices nothing — the gate never reaches
    // it — so emitting a block for it would advertise a toll that does not exist, which is the same
    // defect as understating one. Only a rule strictly INSIDE a tolled scope is emitted, and only
    // when no scope block already carries it.
    for (const rule of rules) {
      if (claimed.has(rule)) continue;
      const inside = scopes.some((s) => s === "/" || rule.pattern.startsWith(`${s.replace(/\/\*$/, "")}/`));
      if (inside) contentBlock(rule.pattern, licensesFor(rule));
    }
  }
  return blocks;
}

/**
 * Build the RSL document for one tenant.
 *
 * Serializes `rslContentBlocks` and nothing else — every decision about WHICH scopes exist and what
 * each costs is made there, so the XML and any rendering of it are the same answer
 * formatted twice rather than two answers that agree until someone edits one.
 *
 * Returns the XML as a string, newline-terminated, with a declaration — some processors are strict
 * about the prolog, and every published example carries one.
 */
/** A licence with a price on it: the only kind a licence server has anything to issue for. */
/**
 * The licence server URL one site's document names: the fleet's base with the site's host as the
 * last path segment (`https://gate.naulon.app/_naulon/olp/example.com`). Its `/token` resolves a
 * posted path against that host, which is the only way a spec-following client's `resource` (the
 * bare `content@url` path) can name a site. Built on the URL's path so a base carrying a query keeps it.
 */
export function licenceServerFor(base: string, host: string): string {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/${host.toLowerCase()}`;
  return u.toString();
}

const sells = (l: LicenseBlock): boolean => l.payment !== undefined && l.payment.type !== "free" && l.payment.amountUsdc !== undefined;

export function buildRslDocument(terms: RslTenantTerms): string {
  const contact = terms.contactUrl ?? `https://${terms.host}/`;
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rsl xmlns="https://rslstandard.org/rsl" max-age="${MAX_AGE_DAYS}">`,
  ];
  for (const block of rslContentBlocks(terms)) {
    const attrs = [`url="${escapeXml(block.pattern)}"`];
    // `server` only on a block that sells something, and only when the owner named one: see the
    // module header, point 1.
    if (terms.licenceServer && block.licenses.some(sells)) {
      attrs.push(`server="${escapeXml(licenceServerFor(terms.licenceServer, terms.host))}"`);
    }
    if (terms.lastmodIso) attrs.push(`lastmod="${escapeXml(terms.lastmodIso)}"`);
    parts.push(`  <content ${attrs.join(" ")}>`);
    for (const l of block.licenses) parts.push(renderLicense(l));
    parts.push(`    <copyright type="organization" contactUrl="${escapeXml(contact)}">${escapeXml(terms.host)}</copyright>`);
    parts.push("  </content>");
  }
  parts.push("</rsl>");
  return `${parts.join("\n")}\n`;
}

/** The media type RSL registers. Served on the document and named in every discovery pointer. */
export const RSL_MEDIA_TYPE = "application/rsl+xml";

/** The path the document is served at, per host. `/license.xml` is the name every RSL example
 *  uses; matching it means a crawler guessing rather than reading robots.txt still finds it. */
export const RSL_PATH = "/license.xml";

/**
 * The one line a publisher adds to their own robots.txt.
 *
 * naulon cannot write it for them: robots.txt is served by THEIR origin, and the gate proxies it
 * untouched. So a dashboard shows this string to copy. The HTTP `Link` header (which naulon does
 * control, and sets on every response it serves) is the automatic half — this is the half that
 * makes the terms discoverable to a crawler that only ever reads robots.txt.
 */
export function robotsLicenseLine(host: string): string {
  return `License: https://${host}${RSL_PATH}`;
}

/** The `Link` header value pointing at a host's licence — RSL's HTTP discovery mechanism, and the
 *  only one naulon can set without the publisher touching anything. */
export function licenseLinkHeader(host: string): string {
  return `<https://${host}${RSL_PATH}>; rel="license"; type="${RSL_MEDIA_TYPE}"`;
}
