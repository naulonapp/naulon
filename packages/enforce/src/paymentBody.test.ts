import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentRequiredBody, paymentRequiredBodyText } from "./paymentBody.ts";
import { formatCrawlerPrice } from "./crawlerPrice.ts";

const base = { publisher: "example.com", endpoint: "/essays/x", tollKind: "read" as const };

test("the offer mirrors CrawlerToll's PaymentOffer field-for-field", () => {
  const b = paymentRequiredBody({ ...base, askMicro: 3000n });
  assert.equal(b.error, "payment_required");
  assert.deepEqual(Object.keys(b), ["error", "message", "offer"]);
  assert.equal(b.offer.rail, "x402");
  assert.equal(b.offer.priceMicros, 3000);
  assert.equal(b.offer.currency, "USDC");
  assert.equal(b.offer.publisher, "example.com");
  assert.equal(b.offer.endpoint, "/essays/x");
});

test("the body's price and the crawler-price header can never disagree", () => {
  for (const micro of [1n, 1000n, 3000n, 5000n, 1_000_000n, 12_345_678n]) {
    const b = paymentRequiredBody({ ...base, askMicro: micro });
    assert.equal(b.offer.metadata.crawlerPrice, formatCrawlerPrice(micro));
    assert.ok(b.message.includes(formatCrawlerPrice(micro)), "and the prose quotes the same figure");
  }
});

test("a sub-cent toll is never advertised as free", () => {
  const b = paymentRequiredBody({ ...base, askMicro: 1000n });
  assert.equal(b.offer.metadata.crawlerPrice, "USD 0.001");
  assert.equal(b.offer.priceMicros, 1000);
  assert.ok(!b.message.includes("USD 0.00 "), "the two-decimal floor must not swallow a real price");
});

test("a citation says cite, a read says read", () => {
  assert.ok(paymentRequiredBody({ ...base, askMicro: 1n, tollKind: "citation" }).message.includes(" cite it"));
  assert.ok(paymentRequiredBody({ ...base, askMicro: 1n }).message.includes(" read it"));
});

test("the body points at the header that carries the real obligation", () => {
  const b = paymentRequiredBody({ ...base, askMicro: 3000n });
  assert.equal(b.offer.metadata.paymentRequiredHeader, "PAYMENT-REQUIRED");
  assert.equal(b.offer.metadata.manifest, "/.well-known/x402");
  assert.ok(b.message.includes("PAYMENT-REQUIRED"));
  assert.equal(b.offer.metadata.humansReadFree, true);
});

test("free is not a toll and a negative ask is a bug, not a discount", () => {
  assert.equal(paymentRequiredBody({ ...base, askMicro: 0n }).offer.priceMicros, 0);
  assert.throws(() => paymentRequiredBody({ ...base, askMicro: -1n }), /invalid ask/);
});

test("an ask past exact-integer range is refused rather than silently rounded", () => {
  const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  assert.throws(() => paymentRequiredBody({ ...base, askMicro: tooBig }), /exceeds exact integer range/);
});

test("the serialized body is parseable JSON and readable in a terminal", () => {
  const text = paymentRequiredBodyText({ ...base, askMicro: 3000n });
  assert.deepEqual(JSON.parse(text), paymentRequiredBody({ ...base, askMicro: 3000n }));
  assert.ok(text.includes("\n  "), "indented — a person reads this at least as often as a machine");
});
