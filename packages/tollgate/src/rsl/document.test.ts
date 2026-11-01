import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublisherConfig } from "@naulon/shared";
import { parseRsl, termsForUrl } from "@naulon/sdk/rsl";
import { STATIC_EXTENSIONS } from "@naulon/sdk/slug";
import {
  buildRslDocument,
  rslContentBlocks,
  contentPatterns,
  freeFilePatterns,
  escapeXml,
  formatAmount,
  licenseBlocks,
  licenseLinkHeader,
  licenceServerFor,
  robotsLicenseLine,
  RSL_MEDIA_TYPE,
  type RslTenantTerms,
} from "./document.ts";

/**
 * These assert the CLAIMS the document makes, not its formatting. A licence file is a public,
 * machine-read statement of what someone may do with a publisher's work and what it costs — the
 * failure mode is not an ugly file, it is granting a right nobody sold or pricing it wrong.
 */

const BASE = { host: "example.test", articlePrefixes: [], priceUsdc: 0.02 };

/** `<content>` blocks that actually charge. Site mode also emits a free block per carve-out and
 *  per static extension, so counting every `<content>` stopped answering "what is priced". */
function pricedBlocks(xml: string): number {
  return xml.split("<content ").filter((b) => b.includes('type="crawl"')).length;
}

test("the document parses as the RSL namespace and declares a max-age", () => {
  const xml = buildRslDocument(BASE);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<rsl xmlns="https:\/\/rslstandard\.org\/rsl" max-age="1">/);
  assert.ok(xml.endsWith("</rsl>\n"));
});

test("search is permitted and FREE — the classifier's rule, said out loud", () => {
  const xml = buildRslDocument(BASE);
  assert.match(xml, /<permits type="usage">search<\/permits>\n\s*<payment type="free"\/>/);
});

test("a read is priced in USD and payable over x402", () => {
  const xml = buildRslDocument(BASE);
  assert.match(xml, /<permits type="usage">ai-input ai-index<\/permits>/);
  assert.match(xml, /<payment type="crawl">/);
  assert.match(xml, /<amount currency="USD">0\.02<\/amount>/);
  assert.match(xml, /<accepts type="application\/x402\+json"\/>/, "no chain known ⇒ the bare element");
});

test("the chain rides in the <accepts> body when known, as CDATA", () => {
  // The one fact an agent would otherwise spend a 402 round trip to learn. Same value the gate's
  // own quote carries — `scheme: exact` is the only scheme it mints.
  const xml = buildRslDocument({ ...BASE, x402Network: "eip155:5042002" });
  assert.match(
    xml,
    /<accepts type="application\/x402\+json"><!\[CDATA\[\{"scheme":"exact","network":"eip155:5042002"\}\]\]><\/accepts>/,
  );
  assert.ok(!xml.includes("<accepts type=\"application/x402+json\"/>"), "no bare element is left behind");
});

test("every priced licence carries the chain, not just the first", () => {
  // A citation licence a crawler could pay is a licence it needs the chain for.
  const xml = buildRslDocument({ ...BASE, citationMultiplier: 5, x402Network: "eip155:8453" });
  assert.equal(xml.match(/eip155:8453/g)?.length, 2, "read and citation both");
});

test("the free licence never carries payment metadata", () => {
  const xml = buildRslDocument({ ...BASE, x402Network: "eip155:8453" });
  const free = xml.slice(xml.indexOf("<permits type=\"usage\">search"), xml.indexOf("<payment type=\"crawl\">"));
  assert.ok(!free.includes("accepts"), "nothing is accepted for a licence that costs nothing");
});

test("NO `server` attribute is ever emitted", () => {
  // The spec: if <content> carries `server`, clients MUST get a licence from it "regardless of the
  // payment type, including when type='free'". That would push Googlebot through a handshake to
  // index a page it may read for nothing — the opposite of humans-and-search-read-free.
  const xml = buildRslDocument({ ...BASE, articlePrefixes: ["/a", "/b"], citationMultiplier: 5 });
  assert.ok(!/\bserver=/.test(xml), "a server attribute would gate the FREE licence too");
});

test("ai-train is never granted — and never prohibited either", () => {
  // naulon sells reads and citations, not training corpora, so it must not grant ai-train. It must
  // also not FORBID it: the publisher never took that position, and per the spec an
  // absent <permits> already means "not explicitly permitted", which is the honest statement.
  const xml = buildRslDocument({ ...BASE, citationMultiplier: 5 });
  assert.ok(!xml.includes("ai-train"), "naulon neither sells training rights nor speaks for the publisher");
  assert.ok(!xml.includes("<prohibits"), "silence is the accurate declaration, not a prohibition");
});

test("use is offered even at the read price, so a buyer can ask for citation rights", () => {
  const one = buildRslDocument({ ...BASE, citationMultiplier: 1 });
  assert.match(one, /<payment type="crawl">\n\s*<amount currency="USD">0\.02<\/amount>/);
  assert.match(one, /<payment type="use">\n\s*<amount currency="USD">0\.02<\/amount>/);
  const absent = buildRslDocument({ ...BASE });
  assert.equal(absent.match(/<payment type="use">/g)?.length, 1, "absent multiplier is 1, and use is still offered");
  const five = buildRslDocument({ ...BASE, citationMultiplier: 5 });
  assert.match(five, /<payment type="use">\n\s*<amount currency="USD">0\.10<\/amount>/);
  assert.equal(licenseBlocks({ ...BASE, citationMultiplier: 5 }).length, 3);
  assert.equal(licenseBlocks({ ...BASE }).length, 3);
});

test("the free licence is emitted BEFORE any priced one", () => {
  const xml = buildRslDocument({ ...BASE, citationMultiplier: 5 });
  assert.ok(xml.indexOf('type="free"') < xml.indexOf('type="crawl"'));
  assert.ok(xml.indexOf('type="crawl"') < xml.indexOf('type="use"'));
});

test("article prefixes become RFC 9309 patterns; no prefixes means the whole site", () => {
  assert.deepEqual(contentPatterns([]), ["/"]);
  assert.deepEqual(contentPatterns(["/articles"]), ["/articles/*"]);
  assert.deepEqual(contentPatterns(["posts"]), ["/posts/*"], "a missing leading slash is repaired");
  assert.deepEqual(contentPatterns(["/a/", "/a"]), ["/a/*"], "a trailing slash is not a second scope");
  assert.deepEqual(contentPatterns(["/b", "/a"]), ["/a/*", "/b/*"], "sorted, so the output is stable");
  assert.deepEqual(contentPatterns(["  ", ""]), ["/"], "blank entries are not scopes");
});

test("every prefix gets its own <content> block, each carrying the full licence set", () => {
  const xml = buildRslDocument({ ...BASE, articlePrefixes: ["/articles", "/notes"] });
  assert.equal(xml.match(/<content /g)?.length, 2);
  assert.equal(xml.match(/<payment type="free"\/>/g)?.length, 2);
  assert.match(xml, /url="\/articles\/\*"/);
  assert.match(xml, /url="\/notes\/\*"/);
});

test("amounts are decimal strings at USDC precision, trimmed where it reads as a price", () => {
  assert.equal(formatAmount(0.02), "0.02");
  // The case an earlier regex got wrong, and it is the price BOTH production publishers charge:
  // it only trimmed when exactly two decimals were significant, so this rendered "0.001000".
  assert.equal(formatAmount(0.001), "0.001");
  assert.equal(formatAmount(0.003), "0.003", "and the 3× citation price off it");
  assert.equal(formatAmount(0.0003), "0.0003", "prod's smallest settled toll");
  assert.equal(formatAmount(0.1), "0.10", "two places minimum — 0.1 reads as an error");
  assert.equal(formatAmount(0.000001), "0.000001", "the USDC atom survives");
  assert.equal(formatAmount(1), "1.00");
  assert.equal(formatAmount(0), "0.00");
  assert.equal(formatAmount(1.5), "1.50");
  assert.equal(formatAmount(Number.NaN), "0.00", "MONEY: a non-number never becomes a price");
  assert.equal(formatAmount(-1), "0.00", "MONEY: nor does a negative one");
});

test("a hostile host or contact URL cannot break out of the document", () => {
  // Both are publisher-controlled. An unescaped `"` closes an attribute; an unescaped `<` opens an
  // element. The one thing worse than no licence file is one that does not parse — or one that
  // parses into terms nobody wrote.
  const xml = buildRslDocument({
    ...BASE,
    host: 'evil"><content url="/"><license><payment type="free"/></license></content><x y="',
    contactUrl: "https://x.test/?a=1&b=2",
  });
  assert.ok(!xml.includes('evil"><content'), "the attribute was not closed early");
  assert.match(xml, /&quot;&gt;&lt;content/);
  assert.match(xml, /contactUrl="https:\/\/x\.test\/\?a=1&amp;b=2"/);
  assert.equal(xml.match(/<content /g)?.length, 1, "no injected second scope");
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
});

test("lastmod is emitted only when known — never invented", () => {
  assert.ok(!buildRslDocument(BASE).includes("lastmod"));
  assert.match(buildRslDocument({ ...BASE, lastmodIso: "2026-08-24T00:00:00Z" }), /lastmod="2026-08-24T00:00:00Z"/);
});

test("the same terms always produce byte-identical XML", () => {
  // So a diff in the served document means the publisher changed, never that the serializer did.
  const t = { ...BASE, articlePrefixes: ["/b", "/a"], citationMultiplier: 3, lastmodIso: "2026-08-24T00:00:00Z" };
  assert.equal(buildRslDocument(t), buildRslDocument({ ...t, articlePrefixes: ["/a", "/b"] }));
});

test("the discovery pointers name the same document and media type", () => {
  assert.equal(robotsLicenseLine("example.test"), "License: https://example.test/license.xml");
  assert.equal(
    licenseLinkHeader("example.test"),
    `<https://example.test/license.xml>; rel="license"; type="application/rsl+xml"`,
  );
  assert.equal(RSL_MEDIA_TYPE, "application/rsl+xml");
});

/* ── whole-site scope ─────────────────────────────────────────────────────────────────────────── */

test("a whole-site toll prices `/`, not the article prefixes", () => {
  // The failure this prevents: a site-mode publisher whose licence lists only /articles/* tells a
  // crawler that /about is unlicensed, while the gate charges for it. The document must say what
  // the gate does.
  const xml = buildRslDocument({
    ...BASE,
    articlePrefixes: ["/articles"],
    gateScope: { mode: "site", excludePrefixes: [] },
  });
  assert.match(xml, /<content url="\/">/);
  assert.ok(!xml.includes("/articles/*"), "prefixes are not the scope when the whole site tolls");
  assert.equal(pricedBlocks(xml), 1, "exactly one PRICED block — the free-file carve-outs are not it");
});

test("an excluded section becomes a MORE SPECIFIC free block, which is how RSL resolves overlap", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: ["docs", "/about"] },
  });
  assert.equal(pricedBlocks(xml), 1);
  assert.match(xml, /<content url="\/">/);
  assert.match(xml, /<content url="\/about\/\*">/);
  assert.match(xml, /<content url="\/docs\/\*">/);
  // The carve-out grants reading free — it is not merely "search is free", because the gate does
  // not toll that section at all and an agent may read it exactly as a person can.
  const aboutBlock = xml.slice(xml.indexOf('url="/about/*"'), xml.indexOf('url="/docs/*"'));
  assert.match(aboutBlock, /<permits type="usage">search ai-input ai-index<\/permits>\n\s*<payment type="free"\/>/);
  assert.ok(!aboutBlock.includes('type="crawl"'), "an excluded section carries no price");
  // And the priced site-wide block still stands for everything else.
  assert.match(xml, /<payment type="crawl">/);
});

test("site mode with no exclusions never emits a stray `/` carve-out", () => {
  const xml = buildRslDocument({ ...BASE, gateScope: { mode: "site", excludePrefixes: ["", "  "] } });
  assert.equal(xml.match(/<content url="\/">/g)?.length, 1, "the priced site block, and no free duplicate of it");
  assert.equal(pricedBlocks(xml), 1);
});

test("prefixes mode is unchanged by the gateScope field being present", () => {
  const withScope = buildRslDocument({ ...BASE, articlePrefixes: ["/a"], gateScope: { mode: "prefixes" } });
  const without = buildRslDocument({ ...BASE, articlePrefixes: ["/a"] });
  assert.equal(withScope, without);
});

// ── The declared amount is the BUYER's total, not the publisher's share ───────
// An operator fee is additive: the 402 asks for price + fee. A licence
// stating the price alone tells a crawler to budget for less than it will be charged.

/** A 10% fee with no floor or cap — the fleet default shape, as `operatorLegsFor` produces it. */
const tenPercent = (priceUsdc: number) => priceUsdc + Math.round(priceUsdc * 1_000_000 * 0.1) / 1_000_000;

test("a priced block declares price + fee when a buyer total is supplied", () => {
  const blocks = licenseBlocks({ ...BASE, priceUsdc: 0.001, buyerTotalUsdc: tenPercent });
  const crawl = blocks.find((b) => b.payment!.type === "crawl");
  assert.ok(crawl);
  assert.equal(crawl.payment!.amountUsdc, 0.0011);
});

test("the citation total is computed on the CITATION price, not scaled from the read total", () => {
  // The distinction only shows with a floor or a cap, which is why the hook is applied per
  // amount. Here: a 500-micro floor makes the read fee 500 and the citation fee 500 too, so
  // scaling the read TOTAL by 5 would overstate the citation by four floors.
  const floored = (priceUsdc: number) => priceUsdc + 0.0005;
  const blocks = licenseBlocks({ ...BASE, priceUsdc: 0.001, citationMultiplier: 5, buyerTotalUsdc: floored });
  const use = blocks.find((b) => b.payment!.type === "use");
  assert.ok(use);
  assert.equal(use.payment!.amountUsdc, 0.0055); // 0.005 + 0.0005, not (0.0015 * 5)
});

test("no buyer-total hook leaves every amount exactly as before — the fee-off document is unchanged", () => {
  const withHook = licenseBlocks({ ...BASE, citationMultiplier: 5 });
  assert.deepEqual(
    withHook.map((b) => b.payment!.amountUsdc),
    [undefined, 0.02, 0.1],
  );
});

test("the rendered document carries the total, not the price", () => {
  const xml = buildRslDocument({ ...BASE, priceUsdc: 0.001, buyerTotalUsdc: tenPercent });
  assert.match(xml, /<amount currency="USD">0\.0011<\/amount>/);
  assert.doesNotMatch(xml, /<amount currency="USD">0\.001<\/amount>/);
});

// ── the static files a whole-site toll does NOT charge for (§FILES-RSL) ─────────────────────────
// `<content url="/">` priced is a claim over every path, and the gate does not charge for a
// stylesheet, an image or a font. The document over-claimed from the day site mode shipped; worse,
// `RslTenantTerms.gateScope` did not declare `includeExtensions`, so structural assignability
// dropped it at the one call site with no compile signal — the emitter was permanently blind to
// the field that decides which files are priced.

test("a whole-site toll declares every static extension free", () => {
  const xml = buildRslDocument({ ...BASE, gateScope: { mode: "site", excludePrefixes: [] } });
  for (const ext of STATIC_EXTENSIONS) {
    assert.ok(xml.includes(`<content url="/*.${ext}$">`), `.${ext} must be declared free`);
  }
  assert.equal(pricedBlocks(xml), 1, "and only `/` is priced");
});

test("an opted-in extension is PRICED — its free block disappears, and no other moves", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [], includeExtensions: ["pdf", "json"] },
  });
  assert.ok(!xml.includes('url="/*.pdf$"'), "a tolled pdf is covered by the priced `/` block");
  assert.ok(!xml.includes('url="/*.json$"'));
  assert.match(xml, /<content url="\/\*\.css\$">/, "everything not opted in stays free");
  assert.match(xml, /<content url="\/\*\.png\$">/);
});

test("a free-file block grants reading, not merely search — the gate does not gate those paths", () => {
  const xml = buildRslDocument({ ...BASE, gateScope: { mode: "site", excludePrefixes: [] } });
  const block = xml.slice(xml.indexOf('url="/*.css$"'));
  assert.match(block, /<permits type="usage">search ai-input ai-index<\/permits>\n\s*<payment type="free"\/>/);
  assert.ok(!block.slice(0, block.indexOf("</content>")).includes('type="crawl"'));
});

test("PREFIXES mode declares no file blocks — the static rule is site mode's", () => {
  const xml = buildRslDocument({ ...BASE, articlePrefixes: ["articles"], gateScope: { mode: "prefixes" } });
  assert.ok(!xml.includes("/*."));
});

test("the declaration is derived from the gate's own list, so it cannot drift", () => {
  // `freeFilePatterns` reads STATIC_EXTENSIONS from @naulon/sdk — the same constant slugFromSitePath
  // builds its matcher from. A hand-copied list here is what would let the licence price a file the
  // gate serves free.
  assert.deepEqual(
    freeFilePatterns(["pdf"]),
    STATIC_EXTENSIONS.filter((e) => e !== "pdf").map((e) => `/*.${e}$`),
  );
  assert.deepEqual(freeFilePatterns([" .PDF "]), freeFilePatterns(["pdf"]), "normalised like the write path");
});

// A key the GATE's scope carries that the LICENCE's does not is a fact the document cannot see.
// Structural assignability drops it silently — no error at the call site, no test failure, just a
// licence that stops describing the toll. This fails to compile the moment the gate grows one.
type SiteScope<T> = Extract<NonNullable<T>, { mode: "site" }>;
type BlindTo = Exclude<keyof SiteScope<PublisherConfig["gateScope"]>, keyof SiteScope<RslTenantTerms["gateScope"]>>;
const _noBlindSpot: [BlindTo] extends [never] ? true : never = true;

test("the licence's scope shape covers every field the gate's does", () => {
  assert.equal(_noBlindSpot, true);
});

/* ── per-path price rules ────────────────────────────────────────────────────────────────────────
 * A licence is the pre-flight budget an RSL crawler authorizes against, so a price rule the
 * document cannot see is a payment that fails at the 402.
 *
 * The invariant every test below is one case of: **for any path, the amount this document declares
 * is the amount `tollPrice` will charge.** That is the same equality `buyerTotalUsdc` exists to
 * keep, one field over. */

/** The read amount the document declares for `pattern`'s block, as a number. */
function amountForBlock(xml: string, pattern: string): number | null {
  const block = xml.split("<content ").find((b) => b.startsWith(`url="${pattern}"`));
  if (!block) return null;
  const m = /<payment type="crawl">\s*<amount currency="USD">([\d.]+)<\/amount>/.exec(block);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** The `use` (citation) amount for `pattern`'s block, or null when the block declares none. */
function citationForBlock(xml: string, pattern: string): number | null {
  const block = xml.split("<content ").find((b) => b.startsWith(`url="${pattern}"`));
  if (!block) return null;
  const m = /<payment type="use">\s*<amount currency="USD">([\d.]+)<\/amount>/.exec(block);
  return m?.[1] === undefined ? null : Number(m[1]);
}

test("PREFIXES: a rule on the tolled section prices that section's block, at the rule's amount", () => {
  const xml = buildRslDocument({
    ...BASE,
    articlePrefixes: ["articles"],
    priceUsdc: 0.03,
    citationMultiplier: 2,
    priceRules: [{ pattern: "/articles", priceUsdc: 0.1 }],
  } satisfies RslTenantTerms);
  // The wire charges 0.10 / 0.20 for this exact shape (measured on the local gate, demo-alice).
  assert.equal(amountForBlock(xml, "/articles/*"), 0.1, "the read amount is the RULE's, not the base");
  assert.equal(citationForBlock(xml, "/articles/*"), 0.2, "the citation rides the rule's price");
  assert.equal(pricedBlocks(xml), 1, "and the rule does NOT also emit a second, duplicate block");
});

test("PREFIXES: the section's own index page is never claimed as tolled by a rule block", () => {
  const xml = buildRslDocument({
    ...BASE,
    articlePrefixes: ["articles"],
    priceRules: [{ pattern: "/articles", priceUsdc: 0.1 }],
  } satisfies RslTenantTerms);
  // `/articles` (no tail) is NOT tolled in prefixes mode — `articleRe` requires a step after the
  // prefix. A bare `<content url="/articles">` block would advertise a toll on the section index.
  assert.equal(amountForBlock(xml, "/articles"), null);
});

test("PREFIXES: a rule outside every tolled section declares nothing — the gate never reaches it", () => {
  const xml = buildRslDocument({
    ...BASE,
    articlePrefixes: ["articles"],
    priceUsdc: 0.03,
    priceRules: [{ pattern: "/marketing", priceUsdc: 5 }],
  } satisfies RslTenantTerms);
  assert.equal(pricedBlocks(xml), 1);
  assert.equal(amountForBlock(xml, "/articles/*"), 0.03, "the tolled section keeps the base");
  assert.ok(!xml.includes('url="/marketing"'), "and the unreachable rule is not advertised at all");
});

test("SITE: each rule becomes its own narrower block, and `/` keeps the base", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceUsdc: 0.01,
    citationMultiplier: 5,
    priceRules: [{ pattern: "/papers", priceUsdc: 0.5 }, { pattern: "/blog", priceUsdc: 0.002 }],
  } satisfies RslTenantTerms);
  assert.equal(amountForBlock(xml, "/"), 0.01);
  assert.equal(amountForBlock(xml, "/papers"), 0.5, "a rule ABOVE the base is declared");
  assert.equal(amountForBlock(xml, "/blog"), 0.002, "and so is one BELOW it — overstating is a lie too");
  assert.equal(citationForBlock(xml, "/papers"), 2.5, "the site multiplier applies inside the rule");
});

test("SITE: a rule setting only a multiplier keeps the base READ price in its own block", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceUsdc: 0.01,
    citationMultiplier: 2,
    priceRules: [{ pattern: "/papers", citationMultiplier: 10 }],
  } satisfies RslTenantTerms);
  // `tollPrice` overrides the two money fields INDEPENDENTLY; a document that assumed a rule sets
  // both would declare a read price the gate does not charge.
  assert.equal(amountForBlock(xml, "/papers"), 0.01);
  assert.equal(citationForBlock(xml, "/papers"), 0.1);
});

test("SITE: a rule patterned `/` prices the site block itself rather than duplicating it", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceUsdc: 0.01,
    priceRules: [{ pattern: "/", priceUsdc: 0.07 }],
  } satisfies RslTenantTerms);
  assert.equal(amountForBlock(xml, "/"), 0.07);
  assert.equal(pricedBlocks(xml), 1);
});

test("a rule's amount carries the buyer total, computed on the RULE's price", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceUsdc: 0.01,
    priceRules: [{ pattern: "/papers", priceUsdc: 0.5 }],
    // A flat 10% stand-in for the operator fee hook: applied PER AMOUNT, never scaled from the base.
    buyerTotalUsdc: (p) => p * 1.1,
  } satisfies RslTenantTerms);
  assert.equal(amountForBlock(xml, "/"), 0.011);
  assert.equal(amountForBlock(xml, "/papers"), 0.55, "not 0.5, and not the base's total");
});

test("no rules ⇒ the document is byte-identical to before the field existed", () => {
  const terms = { ...BASE, articlePrefixes: ["articles"], priceUsdc: 0.03, citationMultiplier: 2 };
  assert.equal(buildRslDocument({ ...terms, priceRules: [] }), buildRslDocument(terms));
  assert.equal(buildRslDocument({ ...terms, priceRules: undefined }), buildRslDocument(terms));
});

/* ── the projection and the document are one answer ──────────────────────────────────────────────
 * Anything that states a publisher's terms renders `rslContentBlocks`, the same array the XML is
 * written from. A renderer that re-derived the terms from configuration would drift from the
 * document the first time the emitter learned a new field; these assertions hold the equality. */

test("every scope the XML declares is in the projection, and nothing else is", () => {
  const terms: RslTenantTerms = {
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: ["legal"] },
    priceUsdc: 0.01,
    citationMultiplier: 5,
    priceRules: [{ pattern: "/papers", priceUsdc: 0.5 }, { pattern: "/blog", citationMultiplier: 10 }],
  };
  const xml = buildRslDocument(terms);
  const inXml = [...xml.matchAll(/<content url="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rslContentBlocks(terms).map((b) => b.pattern), inXml);
});

test("every AMOUNT the XML declares comes from the projection's own licences", () => {
  const terms: RslTenantTerms = {
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceUsdc: 0.01,
    citationMultiplier: 5,
    priceRules: [{ pattern: "/papers", priceUsdc: 0.5 }, { pattern: "/blog", citationMultiplier: 10 }],
  };
  const fromXml = [...buildRslDocument(terms).matchAll(/<amount currency="USD">([\d.]+)</g)].map((m) => Number(m[1]));
  const fromBlocks = rslContentBlocks(terms)
    .flatMap((b) => b.licenses)
    .filter((l) => l.payment!.amountUsdc !== undefined)
    .map((l) => Number(formatAmount(l.payment!.amountUsdc as number)));
  assert.deepEqual(fromXml, fromBlocks);
});

test("a rule the document DROPS is absent from the projection too — the card cannot invent a term", () => {
  // Prefixes mode tolls only `/articles`, so a `/notes` rule is unreachable and the emitter omits
  // it. A card built from the raw rule list would advertise it; one built from this cannot.
  const terms: RslTenantTerms = {
    ...BASE,
    articlePrefixes: ["articles"],
    priceUsdc: 0.03,
    priceRules: [{ pattern: "/articles", priceUsdc: 0.1 }, { pattern: "/notes", citationMultiplier: 10 }],
  };
  const patterns = rslContentBlocks(terms).map((b) => b.pattern);
  assert.deepEqual(patterns, ["/articles/*"]);
  assert.ok(!buildRslDocument(terms).includes("/notes"));
});

test("a free carve-out carries no priced licence, so the card renders it as free", () => {
  const blocks = rslContentBlocks({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: ["legal"] },
    priceUsdc: 0.01,
  } satisfies RslTenantTerms);
  const legal = blocks.find((b) => b.pattern === "/legal/*");
  assert.ok(legal, "the carve-out is a scope of its own");
  assert.ok(legal.licenses.every((l) => l.payment!.amountUsdc === undefined));
});

// --- what a publisher DECLARED (0220) ----------------------------------------------------------

test("a prohibited term renders as prohibits, never as an omission", () => {
  const xml = buildRslDocument({ ...BASE, termsPolicy: { "ai-index": "prohibit" } });
  assert.match(xml, /<prohibits type="usage">ai-index<\/prohibits>/);
  assert.equal(/<permits type="usage">[^<]*ai-index/.test(xml), false);
});

test("a refusal is not priced — no payment element rides with a prohibits block", () => {
  const xml = buildRslDocument({ ...BASE, termsPolicy: { "ai-index": "prohibit" } });
  const refusal = xml.split("<license>").find((b) => b.includes("<prohibits"));
  assert.ok(refusal);
  assert.equal(refusal.includes("<payment"), false);
  assert.equal(refusal.includes("<permits"), false);
});

test("ai-train by agreement names a payment type and a contact, never an amount", () => {
  const xml = buildRslDocument({
    ...BASE,
    termsPolicy: { "ai-train": "by-agreement", contact: "mailto:rights@example.com" },
  });
  assert.match(xml, /<permits type="usage">ai-train<\/permits>/);
  assert.match(xml, /<payment type="training"\/>/);
  assert.match(xml, /<legal type="contact">mailto:rights@example\.com<\/legal>/);
  assert.equal(/<payment type="training"[\s\S]*?<amount/.test(xml), false);
});

test("a negotiated term is never advertised as payable over x402", () => {
  const xml = buildRslDocument({
    ...BASE,
    x402Network: "base",
    termsPolicy: { "ai-train": "by-agreement", contact: "mailto:rights@example.com" },
  });
  const training = xml.split("<license>").find((b) => b.includes('type="training"'));
  assert.ok(training);
  assert.equal(training.includes("<accepts"), false);
});

test("a contact is escaped like every other publisher-controlled string", () => {
  const xml = buildRslDocument({
    ...BASE,
    termsPolicy: { "ai-train": "by-agreement", contact: "https://x.test/?a=1&b=2" },
  });
  assert.match(xml, /<legal type="contact">https:\/\/x\.test\/\?a=1&amp;b=2<\/legal>/);
});

test("an unstated policy emits no prohibits and no legal at all", () => {
  const xml = buildRslDocument(BASE);
  assert.equal(xml.includes("<prohibits"), false);
  assert.equal(xml.includes("<legal"), false);
});

// ---- C3: naming a licence server on paid content ----

test("a named licence server goes on every block that sells something, and on no free-only block", () => {
  const LS = "https://gate.example/_naulon/olp";
  const site: RslTenantTerms = { ...BASE, gateScope: { mode: "site", excludePrefixes: ["about"] }, licenceServer: LS };
  const blocks = buildRslDocument(site).split("<content ").slice(1);
  const priced = blocks.filter((b) => b.includes('type="crawl"'));
  const freeOnly = blocks.filter((b) => !b.includes('type="crawl"') && !b.includes('type="use"'));
  assert.ok(priced.length >= 1 && freeOnly.length >= 1, "fixture has both kinds of block");
  // The server names this site: RSL posts `content@url` (a path) verbatim, so a shared URL could not.
  for (const b of priced) assert.match(b, /^url="\/[^"]*" server="https:\/\/gate\.example\/_naulon\/olp\/example\.test"/);
  for (const b of freeOnly) assert.ok(!b.includes("server="), "a free section needs no licence at all");
});

test("without a licence server the document is byte-identical to one that never knew about it", () => {
  const withField = buildRslDocument({ ...BASE, licenceServer: undefined });
  assert.equal(withField, buildRslDocument({ ...BASE }));
  assert.ok(!withField.includes("server="));
});

test("the licence server URL keeps a base's query and is escaped like every other attribute", () => {
  const xml = buildRslDocument({ ...BASE, licenceServer: "https://gate.example/olp/?a=1&b=2" });
  assert.match(xml, /server="https:\/\/gate\.example\/olp\/example\.test\?a=1&amp;b=2"/);
});

test("licenceServerFor puts the lowercased host last on the base path, port included", () => {
  assert.equal(licenceServerFor("https://gate.example/_naulon/olp", "WWW.Example.com"), "https://gate.example/_naulon/olp/www.example.com");
  assert.equal(licenceServerFor("http://127.0.0.1:11100/_naulon/olp/", "127.0.0.1:11100"), "http://127.0.0.1:11100/_naulon/olp/127.0.0.1:11100");
});

test("an anchored rule is stated as both literal patterns, so a spec client prices a query the way the gate does", () => {
  const xml = buildRslDocument({
    ...BASE,
    gateScope: { mode: "site", excludePrefixes: [] },
    priceRules: [{ pattern: "/papers/preview$", priceUsdc: 0.5 }],
  } satisfies RslTenantTerms);
  assert.equal(amountForBlock(xml, "/papers/preview$"), 0.5);
  assert.equal(amountForBlock(xml, "/papers/preview?*"), 0.5, "the query form carries the same price");
  // Read the published bytes back the way a client does: literally, path plus query.
  const doc = parseRsl(xml);
  assert.deepEqual(termsForUrl(doc, "https://example.test/papers/preview")?.scopes[0], "/papers/preview$");
  assert.deepEqual(termsForUrl(doc, "https://example.test/papers/preview?utm=feed")?.scopes[0], "/papers/preview?*");
  // A free-file carve-out the gate serves free whatever its query says so too.
  assert.ok(xml.includes('url="/*.css?*"'), "the free-file pattern is stated with its query form");
  assert.deepEqual(termsForUrl(doc, "https://example.test/site.css?v=3")?.scopes[0], "/*.css?*");
});

test("an agent-bound price rule never reaches the public document", () => {
  const agentOnly = { ...BASE, articlePrefixes: ["essays"], priceRules: [{ pattern: "/essays/*", priceUsdc: 0.2, agent: "chatgpt.com" }] };
  assert.deepEqual(rslContentBlocks(agentOnly), rslContentBlocks({ ...BASE, articlePrefixes: ["essays"] }));
  assert.doesNotMatch(buildRslDocument(agentOnly), /0\.2\b/);
});
