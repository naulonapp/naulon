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

test("buildX402Manifest advertises catalogUrl when the publisher sets one", () => {
  const m = buildX402Manifest({ ...fixturePublisher(), catalogUrl: "https://example.com/api/catalog" });
  assert.deepEqual(m.catalog, { url: "https://example.com/api/catalog" });
});

test("buildX402Manifest omits catalog when unset", () => {
  assert.equal(buildX402Manifest(fixturePublisher()).catalog, undefined);
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

// ── the manifest must describe the scope and chain actually in force ─────────────
// Both of these advertised the DEFAULT rather than the tenant's own setting, so the one
// document an agent reads before paying disagreed with the 402 it then received.

test("a site-scoped publisher advertises site scope, not a prefix list that understates it", () => {
  // The reference publisher's shape: gate_scope {mode:"site"} with a vestigial
  // articlePrefixes:["articles"] left over from prefix mode. Printing that list told an
  // agent four-fifths of the site was free to crawl, when none of it was.
  const m = buildX402Manifest({
    ...fixturePublisher(),
    gateScope: { mode: "site", excludePrefixes: ["api", "auth"] },
  });
  assert.equal(m.resources.scope, "site");
  assert.deepEqual(m.resources.excludePrefixes, ["api", "auth"]);
  assert.equal(m.resources.pathPrefixes, undefined, "absent is honest; a wrong list is not");
  assert.match(m.resources.note, /Every path/);
});

test("a prefix-scoped publisher is unchanged, and says so explicitly", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.resources.scope, "prefixes");
  assert.deepEqual(m.resources.pathPrefixes, ["essays", "articles"]);
  assert.equal(m.resources.excludePrefixes, undefined);
});

test("the manifest's chain follows the TENANT's settlementNetwork", async () => {
  const { getNetwork } = await import("@naulon/shared");
  const m = buildX402Manifest({ ...fixturePublisher(), settlementNetwork: "base" }, getNetwork("base"));
  assert.equal(m.payment.network, "eip155:8453");
  assert.equal(m.payment.chainId, 8453);
  assert.equal(m.payment.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
});

// ── The proof link, discoverable ──────────────────────────────────────────────
// A non-SDK buyer reads the manifest to learn the gate's shape. `license.verify` told it where
// an event could be looked up; it said nothing about the permanent record or the page a reader
// opens, so a buyer building its own citation block had to know both from documentation.
test("the manifest advertises the record route and the proof page, host pre-filled", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.license.record, "/licenses/{jti}/record");
  assert.equal(m.license.proof, "https://naulon.app/verify?host=test.host&jti={jti}");
});

test("the proof template follows VERIFY_PAGE_URL, and keeps a query the page already carries", async () => {
  const { resetConfig } = await import("@naulon/shared");
  const prev = process.env.VERIFY_PAGE_URL;
  process.env.VERIFY_PAGE_URL = "https://self.host/check?lang=de";
  resetConfig();
  try {
    const m = buildX402Manifest(fixturePublisher());
    assert.equal(m.license.proof, "https://self.host/check?lang=de&host=test.host&jti={jti}");
  } finally {
    if (prev === undefined) delete process.env.VERIFY_PAGE_URL;
    else process.env.VERIFY_PAGE_URL = prev;
    resetConfig();
  }
});
