/**
 * Toll discoverability: the `/.well-known/x402` manifest and the `Link:
 * rel="payment"` header on a 402. The manifest must advertise the terms an agent
 * needs to pay — without ever naming an author wallet (payTo is per-article).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-discover-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { buildX402Manifest, PAYMENT_LINK_HEADER } = await import("@naulon/enforce");
const { usdc } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** A fixture publisher — the manifest never calls credits, so a no-op resolves. */
function fixturePublisher(): PublisherConfig {
  return {
    id: "test",
    originUrl: "http://origin.test",
    articlePrefixes: ["essays", "articles"],
    price: usdc(0.002),
    citationMultiplier: 5,
    credits: { resolve: async () => undefined },
    licenseIdentity: "naulon:test.host",
  };
}

test("buildX402Manifest derives both price legs from the publisher", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.payment.price.read.usdc, 0.002);
  assert.equal(m.payment.price.read.atomic, "2000");
  assert.equal(m.payment.price.citation.usdc, 0.01); // 0.002 * 5
  assert.equal(m.payment.price.citation.atomic, "10000");
  assert.equal(m.payment.price.citation.multiplier, 5);
  assert.equal(m.payment.currency, "USDC");
  assert.equal(m.payment.network, "eip155:5042002");
  assert.equal(m.humansReadFree, true);
  assert.deepEqual(m.resources.pathPrefixes, ["essays", "articles"]);
  assert.equal(m.license.identity, "naulon:test.host");
});

test("manifest never names an author wallet (payTo is a per-article policy)", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(m.payment.payTo), "payTo describes derivation, lists no wallet");
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(JSON.stringify(m.resources)), "no wallet anywhere in resources");
});

test("GET /.well-known/x402 serves the manifest for the served host", async () => {
  const res = await app.request("/.well-known/x402");
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReturnType<typeof buildX402Manifest>;
  assert.equal(body.x402Version, 2);
  assert.equal(body.humansReadFree, true);
  assert.ok(body.payment.price.read.atomic.length > 0);
});

test("a 402 carries the Link: rel=payment pointer to the manifest", async () => {
  const res = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("Link"), PAYMENT_LINK_HEADER);
  assert.match(res.headers.get("Link") ?? "", /\/\.well-known\/x402>;\s*rel="payment"/);
});

test("a human request is not tolled and gets no payment Link", async () => {
  const res = await app.request("/essays/on-stillness", {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  assert.notEqual(res.status, 402);
  assert.equal(res.headers.get("Link"), null);
});
