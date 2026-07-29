/**
 * Cloudflare pay-per-crawl interop, asserted on real gate responses.
 *
 * crawlerPrice.test.ts proves the FORMATTER; this proves the WIRING — that a crawler
 * fluent in Cloudflare's vocabulary can read a naulon 402 without decoding the base64
 * x402 payload, and that the headers never appear where they would lie:
 *   - never on a human's free read (that would read as a charge for a free page)
 *   - `crawler-charged` never on a 402 (nothing was charged)
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-crawler-interop-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { parseCrawlerPrice } = await import("@naulon/enforce");

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const AGENT = { "x-naulon-agent": "tester" };
const HUMAN = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };

test("a 402 advertises the price in Cloudflare's vocabulary", async () => {
  const res = await app.request("/essays/on-stillness", { headers: AGENT });
  assert.equal(res.status, 402);

  const price = res.headers.get("crawler-price");
  assert.ok(price, "a 402 must carry crawler-price");
  assert.match(price, /^USD \d+\.\d{2,6}$/, `unexpected shape: ${price}`);
});

test("the advertised price is never zero — the sub-cent toll must not read as free", async () => {
  const res = await app.request("/essays/on-stillness", { headers: AGENT });
  const price = res.headers.get("crawler-price");

  const micro = parseCrawlerPrice(price);
  assert.ok(micro !== null, `crawler-price must parse: ${price}`);
  assert.ok(micro > 0n, `a real toll advertised as ${price} would tell a crawler the read is free`);
});

test("crawler-price agrees with the x402 payload the same 402 carries", async () => {
  const res = await app.request("/essays/on-stillness", { headers: AGENT });

  const header = res.headers.get("PAYMENT-REQUIRED");
  assert.ok(header, "the 402 still carries the x402 header");
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { amount: string }[];
  };

  // Single-author fixture: one leg, so the advertised total is that leg's amount.
  // Two vocabularies for one price — if they can disagree, one of them is a lie.
  const fromX402 = BigInt(payload.accepts[0]!.amount);
  assert.equal(parseCrawlerPrice(res.headers.get("crawler-price")), fromX402);
});

test("crawler-charged never appears on a 402 — nothing was charged", async () => {
  const res = await app.request("/essays/on-stillness", { headers: AGENT });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("crawler-charged"), null);
});

test("a human's free read carries no crawler-* headers at all", async () => {
  const res = await app.request("/essays/on-stillness", { headers: HUMAN });
  assert.notEqual(res.status, 402);
  // Humans read free, forever. A price or a charge on this response would be false.
  assert.equal(res.headers.get("crawler-price"), null);
  assert.equal(res.headers.get("crawler-charged"), null);
});
