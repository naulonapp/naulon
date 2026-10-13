import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentRequiredBody, paymentRequiredBodyText } from "./paymentBody.ts";
import { formatCrawlerPrice } from "./crawlerPrice.ts";
import { agentGuide } from "./agentGuide.ts";
import { paymentFailureDetail } from "./paymentRemedy.ts";
import type { SettlementLegReq } from "./build402.ts";

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

const leg = (amount: string): SettlementLegReq => ({
  role: "author",
  requirements: {
    scheme: "exact", network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000",
    amount, payTo: "0xa", maxTimeoutSeconds: 1,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" },
  },
});
const guide = agentGuide({
  resource: { url: "https://example.com/essays/x", title: "X" }, tollKind: "read",
  legs: [leg("3000")], links: { guide: "https://g.example", manifest: "/.well-known/x402" },
});

test("without a guide the body is exactly today's three keys and today's message", () => {
  const b = paymentRequiredBody({ ...base, askMicro: 3000n });
  assert.deepEqual(Object.keys(b), ["error", "message", "offer"]);
  assert.ok(b.message.startsWith("This request was classified as an automated agent"));
});

test("a guide adds three keys after the offer and leaves the offer untouched", () => {
  const plain = paymentRequiredBody({ ...base, askMicro: 3000n });
  const b = paymentRequiredBody({ ...base, askMicro: 3000n, guide });
  assert.deepEqual(Object.keys(b), ["error", "message", "offer", "forYourUser", "howToPay", "links"]);
  assert.deepEqual(b.offer, plain.offer);
  assert.equal(b.error, "payment_required");
});

test("with a guide the message speaks to a relaying assistant and still names the header", () => {
  const m = paymentRequiredBody({ ...base, askMicro: 3000n, guide }).message;
  assert.ok(m.startsWith("If you are an AI assistant acting for a person:"));
  assert.ok(m.includes("https://example.com/essays/x"));
  assert.ok(m.includes("PAYMENT-REQUIRED"));
  assert.ok(m.includes(" on Arc"));
  assert.ok(m.includes(formatCrawlerPrice(3000n)));
  assert.ok(m.includes("https://g.example"));
});

test("the message sends wallet setup to the fund page when there is one, else to the guide", () => {
  const funded = agentGuide({
    resource: { url: "https://example.com/essays/x", title: "X" }, tollKind: "read",
    legs: [leg("3000")], links: { guide: "https://g.example", manifest: "/.well-known/x402", fund: "https://f.example/buyer" },
  });
  assert.match(paymentRequiredBody({ ...base, askMicro: 3000n, guide: funded }).message, /set up an agent wallet, see https:\/\/f\.example\/buyer\./);
  assert.match(paymentRequiredBody({ ...base, askMicro: 3000n, guide }).message, /set up an agent wallet, see https:\/\/g\.example\./);
});

test("a citation with a guide still says citation", () => {
  assert.match(paymentRequiredBody({ ...base, askMicro: 3000n, tollKind: "citation", guide }).message, /automated citation/);
});

test("a licence refusal and a guide coexist, licence keys first", () => {
  const b = paymentRequiredBody({ ...base, askMicro: 3000n, guide, licence: { error: "price_rose" } });
  assert.deepEqual(Object.keys(b), ["error", "message", "offer", "licence_error", "forYourUser", "howToPay", "links"]);
});

test("a failure rides last, after the guide", () => {
  const failure = paymentFailureDetail("insufficient_funds", "insufficient_balance", guide);
  const b = paymentRequiredBody({ ...base, askMicro: 3000n, guide, failure });
  assert.equal(Object.keys(b).at(-1), "failure");
  assert.equal(b.failure?.detail, "insufficient_balance");
});

test("the serialized body with a guide and a failure stays under 3 KB", () => {
  const failure = paymentFailureDetail("settlement_failed", "x".repeat(200), guide);
  assert.ok(Buffer.byteLength(paymentRequiredBodyText({ ...base, askMicro: 3000n, guide, failure })) < 3072);
});

test("a very long URL appears only where it must, so the body grows by it at most twice", () => {
  const url = `https://example.com/${"p".repeat(1500)}`;
  const g = agentGuide({ resource: { url, title: "X" }, tollKind: "read", legs: [leg("3000")], links: { guide: "https://g.example", manifest: "/m" } });
  const b = paymentRequiredBody({ ...base, endpoint: new URL(url).pathname, askMicro: 3000n, guide: g });
  assert.ok(!b.message.includes(url), "the message refers to readFreeUrl instead");
  assert.ok(!b.forYourUser!.text.includes(url));
  assert.equal(b.forYourUser!.readFreeUrl, url, "the full URL still travels, once");
  assert.ok(Buffer.byteLength(paymentRequiredBodyText({ ...base, endpoint: new URL(url).pathname, askMicro: 3000n, guide: g })) < 3072 + 2 * url.length);
});
