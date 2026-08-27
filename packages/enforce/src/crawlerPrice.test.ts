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
  crawlerBudgetVerdict,
  declaredCrawlerBudget,
  formatCrawlerPrice,
  parseCrawlerPrice,
  settledChargedMicro,
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

test("the declared budget reads either header, proactive first", () => {
  assert.equal(declaredCrawlerBudget({ maxPrice: "USD 0.05" }), 50_000n);
  assert.equal(declaredCrawlerBudget({ exactPrice: "USD 0.02" }), 20_000n);
  // Cloudflare documents them as mutually exclusive; if both arrive the crawler's own
  // stated ceiling wins, so we can never overstate what it agreed to.
  assert.equal(
    declaredCrawlerBudget({ maxPrice: "USD 0.05", exactPrice: "USD 9.99" }),
    50_000n,
    "the proactive ceiling must win over a reactive figure",
  );
  // An unusable proactive value falls through to the reactive one rather than
  // swallowing the crawler's intent entirely.
  assert.equal(declaredCrawlerBudget({ maxPrice: "EUR 5.00", exactPrice: "USD 0.02" }), 20_000n);
});

test("a crawler that stated nothing is null, not zero", () => {
  assert.equal(declaredCrawlerBudget({}), null);
  assert.equal(declaredCrawlerBudget({ maxPrice: null, exactPrice: undefined }), null);
  // The distinction matters: zero would read as "will pay nothing", which is a claim
  // the crawler never made.
  assert.equal(crawlerBudgetVerdict(null, 1000n), null);
});

test("budget verdict compares the ceiling against the real ask", () => {
  assert.equal(crawlerBudgetVerdict(50_000n, 1000n), "within");
  assert.equal(crawlerBudgetVerdict(1000n, 1000n), "within", "exactly the ask is within it");
  assert.equal(crawlerBudgetVerdict(999n, 1000n), "over");
  assert.equal(crawlerBudgetVerdict(0n, 1000n), "over");
});

test("crawler-charged is what the buyer PAID, not what they were asked", () => {
  // The stock-payer shape (naulon#73): a 3-leg quote, only accepts[0] signed.
  const legs = [
    { requirements: { amount: "15000" } }, // author — signed
    { requirements: { amount: "5000" } },  // co-author — never offered to a stock client
    { requirements: { amount: "2000" } },  // operator fee — likewise
  ];
  const forgone = [{ amount: "5000" }, { amount: "2000" }];

  assert.equal(totalChargedMicro(legs), 22_000n, "the ASK is still the whole quote");
  assert.equal(settledChargedMicro(legs, forgone), 15_000n, "but only the author leg left the wallet");
  assert.equal(formatCrawlerPrice(settledChargedMicro(legs, forgone)), "USD 0.015");
  // The bug this pins: emitting the ask told a stock payer they were charged $0.022 when
  // $0.015 moved. `crawler-charged` is a claim about money — it has to be the real total.
  assert.notEqual(formatCrawlerPrice(totalChargedMicro(legs)), "USD 0.015");
});

test("a naulon-aware payer forgoes nothing, so the header is unchanged", () => {
  const legs = [{ requirements: { amount: "15000" } }, { requirements: { amount: "2000" } }];
  // Absent and empty must both mean "nothing was forgone" — the settle path omits the key.
  assert.equal(settledChargedMicro(legs, undefined), 17_000n);
  assert.equal(settledChargedMicro(legs, []), 17_000n);
  assert.equal(settledChargedMicro(legs, undefined), totalChargedMicro(legs));
});

test("the settled total never goes negative", () => {
  // Can't happen from a real settle (forgone is built from the same leg list), but a negative
  // would throw in formatCrawlerPrice and turn a PAID read into a 500 — fail toward 0, not 500.
  const legs = [{ requirements: { amount: "1000" } }];
  assert.equal(settledChargedMicro(legs, [{ amount: "9999" }]), 0n);
  assert.equal(formatCrawlerPrice(settledChargedMicro(legs, [{ amount: "9999" }])), "USD 0.00");
});
