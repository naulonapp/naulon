/**
 * The two halves of RSL, against each other.
 *
 * `document.ts` writes a publisher's terms; `@naulon/sdk/rsl` reads anyone's. They live in
 * different repos and were written five weeks apart, so nothing but a test makes them agree — and
 * the failure they would have is silent: a document that still validates, still serves, and no
 * longer says what the toll charges.
 *
 * Every assertion here is a claim a BUYER acts on, phrased the way the buyer asks it: what may I do
 * with this url, and what will it cost me. Which is why this file lives here rather than beside
 * either half — it is the only place both exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  licenseUrlFromLinkHeader,
  licenseUrlFromRobots,
  parseRsl,
  termsForUrl,
  x402Offer,
} from "@naulon/sdk/rsl";
import { buildRslDocument, licenseLinkHeader, robotsLicenseLine, RSL_PATH, type RslTenantTerms } from "./document.ts";

const HOST = "pub.example";

/** A publisher with a 10% operator fee riding on each read. */
const base: RslTenantTerms = {
  host: HOST,
  articlePrefixes: ["/articles"],
  priceUsdc: 0.001,
  buyerTotalUsdc: (p) => Math.round(p * 1.1 * 1e6) / 1e6,
  x402Network: "eip155:8453",
};

const readTerms = (terms: RslTenantTerms, url: string) => termsForUrl(parseRsl(buildRslDocument(terms)), url);

test("a buyer reads back the price the publisher's toll will actually quote", () => {
  // A document declaring the AUTHOR's price for a toll that charges the buyer total makes an agent
  // that budgets from the licence under-authorize and meet a 402 it had already agreed to pay.
  const t = readTerms(base, `https://${HOST}/articles/one`)!;
  assert.equal(t.usage["ai-input"], true);
  assert.equal(t.usage["ai-index"], true);
  assert.equal(t.read?.paymentType, "crawl");
  assert.deepEqual(t.read?.amount, { value: 0.0011, currency: "USD" });
  assert.equal(t.obligation, "inline");
});

test("the rail is readable without a 402 — scheme and chain, from the licence alone", () => {
  const t = readTerms(base, `https://${HOST}/articles/one`)!;
  assert.deepEqual(x402Offer(t), { scheme: "exact", network: "eip155:8453" });
});

test("search is free and says so, on the same url the read is priced on", () => {
  const t = readTerms(base, `https://${HOST}/articles/one`)!;
  assert.equal(t.usage["search"], true);
});

test("training is neither granted nor forbidden — the publisher never took a side", () => {
  // `ai-train` appears in no <permits> because naulon does not sell training corpora, and in no
  // <prohibits> because inventing that policy on a publisher's behalf is not ours to do. A reader
  // must therefore find SILENCE, which RSL defines as "not explicitly permitted".
  const t = readTerms(base, `https://${HOST}/articles/one`)!;
  assert.equal(t.usage["ai-train"], undefined);
});

test("a path outside the tolled prefixes carries no terms at all", () => {
  assert.equal(readTerms(base, `https://${HOST}/about`), null);
});

test("a whole-site toll prices `/`, and the carved-out sections read free", () => {
  const site: RslTenantTerms = {
    ...base,
    articlePrefixes: [],
    gateScope: { mode: "site", excludePrefixes: ["/docs"] },
  };
  assert.deepEqual(readTerms(site, `https://${HOST}/anything`)!.read?.amount, { value: 0.0011, currency: "USD" });
  const free = readTerms(site, `https://${HOST}/docs/getting-started`)!;
  assert.equal(free.read?.paymentType, "free");
  assert.equal(free.usage["ai-input"], true, "an excluded section is not gated — an agent reads it like a person");
});

test("a whole-site toll leaves static files free unless the publisher claws one back", () => {
  const site: RslTenantTerms = {
    ...base,
    articlePrefixes: [],
    gateScope: { mode: "site", excludePrefixes: [], includeExtensions: ["pdf"] },
  };
  assert.equal(readTerms(site, `https://${HOST}/assets/site.css`)!.read?.paymentType, "free");
  // The opted-in extension has no free block, so the site-wide priced scope governs it.
  assert.deepEqual(readTerms(site, `https://${HOST}/papers/q.pdf`)!.read?.amount, {
    value: 0.0011,
    currency: "USD",
  });
});

test("a citation multiplier adds a dearer licence without changing what a READ costs", () => {
  const t = readTerms({ ...base, citationMultiplier: 3 }, `https://${HOST}/articles/one`)!;
  // Emission order is the contract: the per-fetch `crawl` price is the read, and the `use` block
  // that costs three times as much must not become the price an agent budgets a read at.
  assert.equal(t.read?.paymentType, "crawl");
  assert.deepEqual(t.read?.amount, { value: 0.0011, currency: "USD" });
});

test("the published pointers are the pointers the locator reads", () => {
  // Both channels, round-tripped: a publisher following the instructions must be findable by the
  // locator. These are two independently hand-written strings.
  assert.equal(licenseUrlFromRobots(robotsLicenseLine(HOST)), `https://${HOST}${RSL_PATH}`);
  assert.equal(licenseUrlFromLinkHeader(licenseLinkHeader(HOST)), `https://${HOST}${RSL_PATH}`);
});

test("a fee-free fleet declares the publisher's price unchanged", () => {
  const { buyerTotalUsdc: _drop, ...noFee } = base;
  assert.deepEqual(readTerms(noFee, `https://${HOST}/articles/one`)!.read?.amount, {
    value: 0.001,
    currency: "USD",
  });
});
