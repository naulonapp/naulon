/**
 * The Cloudflare crawler-* vocabulary, with the sub-cent case pinned.
 *
 * The defect these guard against is a money lie in either direction: a real price
 * advertised as `USD 0.00` (free), or `crawler-charged` reporting the quote instead of
 * what the buyer actually authorized across legs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CRAWLER_CHARGED_HEADER,
  CRAWLER_EXACT_PRICE_HEADER,
  CRAWLER_MAX_PRICE_HEADER,
  CRAWLER_PRICE_HEADER,
  formatCrawlerPrice,
  parseCrawlerPrice,
  totalChargedMicro,
} from "./crawlerPrice.ts";

test("header names match Cloudflare's documented vocabulary exactly", () => {
  assert.equal(CRAWLER_MAX_PRICE_HEADER, "crawler-max-price");
  assert.equal(CRAWLER_EXACT_PRICE_HEADER, "crawler-exact-price");
  assert.equal(CRAWLER_PRICE_HEADER, "crawler-price");
  assert.equal(CRAWLER_CHARGED_HEADER, "crawler-charged");
});

test("a sub-cent citation toll never advertises as free", () => {
  // 1000 micro = $0.001. Two-decimal rounding would render "USD 0.00" — a free read.
  assert.equal(formatCrawlerPrice(1000), "USD 0.001");
  // The USDC floor itself still renders as a nonzero price.
  assert.equal(formatCrawlerPrice(1), "USD 0.000001");
});

test("ordinary amounts keep Cloudflare's two-decimal shape", () => {
  assert.equal(formatCrawlerPrice(1_500_000), "USD 1.50");
  assert.equal(formatCrawlerPrice(2_000_000), "USD 2.00");
  assert.equal(formatCrawlerPrice(50_000), "USD 0.05");
  assert.equal(formatCrawlerPrice(0), "USD 0.00");
});

test("format accepts the atomic string the requirements carry", () => {
  // buildRequirements() stores `amount` as an atomic string — format it without a
  // float round-trip.
  assert.equal(formatCrawlerPrice("1000"), "USD 0.001");
  assert.equal(formatCrawlerPrice(10_000_000n), "USD 10.00");
});

test("format refuses a non-integer or negative atomic amount", () => {
  assert.throws(() => formatCrawlerPrice(-1), /invalid crawler price/);
  assert.throws(() => formatCrawlerPrice(0.5), /must be an integer/);
  assert.throws(() => formatCrawlerPrice("1.5"), /integer digits/);
});

test("parse reads what a Cloudflare-trained crawler sends", () => {
  assert.equal(parseCrawlerPrice("USD 0.05"), 50_000n);
  assert.equal(parseCrawlerPrice("USD 1.50"), 1_500_000n);
  assert.equal(parseCrawlerPrice("USD 0.001"), 1000n);
  assert.equal(parseCrawlerPrice("usd 2"), 2_000_000n);
  assert.equal(parseCrawlerPrice("  USD 0.10  "), 100_000n);
});

test("parse returns null — never zero — for anything unusable", () => {
  // null must not be read as a price of zero by any caller.
  assert.equal(parseCrawlerPrice(null), null);
  assert.equal(parseCrawlerPrice(undefined), null);
  assert.equal(parseCrawlerPrice(""), null);
  assert.equal(parseCrawlerPrice("EUR 1.00"), null, "another currency is not our price");
  assert.equal(parseCrawlerPrice("1.00"), null, "no currency at all");
  assert.equal(parseCrawlerPrice("USD -1.00"), null);
  assert.equal(parseCrawlerPrice("USD abc"), null);
  assert.equal(parseCrawlerPrice("USD 0.0000001"), null, "finer than USDC can hold");
});

test("format and parse round-trip", () => {
  for (const micro of [0n, 1n, 1000n, 50_000n, 1_500_000n, 123_456_789n]) {
    assert.equal(parseCrawlerPrice(formatCrawlerPrice(micro)), micro, `round-trip ${micro}`);
  }
});

test("crawler-charged sums every leg, not the quote price", () => {
  // Co-author legs DIVIDE the author price; an operator fee leg ADDS to it. Reporting
  // the quote would understate what the buyer authorized.
  const legs = [
    { requirements: { amount: "600" } }, // primary author
    { requirements: { amount: "400" } }, // co-author (divides the 1000 author price)
    { requirements: { amount: "250" } }, // operator fee (additive)
  ];
  assert.equal(totalChargedMicro(legs), 1250n);
  assert.equal(formatCrawlerPrice(totalChargedMicro(legs)), "USD 0.00125");
});

test("a single-author toll charges exactly the quote", () => {
  assert.equal(totalChargedMicro([{ requirements: { amount: "1000" } }]), 1000n);
  assert.equal(totalChargedMicro([]), 0n);
});
