/**
 * Tri-state crawler policy: allow reads free · unlisted agents pay (stock 402)
 * · blocked agents are refused 403 EVEN IF they present payment. Block beats
 * allow on overlap (fail-safe; the control plane rejects overlap at write).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-crawlerpolicy-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;

// A stub credits resolver that returns a minimal ArticleCredits for any slug,
// so agents actually reach the 402 path. The brief's original `return undefined`
// caused quote() to return undefined for every request, making agents get 200
// (passthrough "unknown article") instead of 402 — contradicting tests 5 and 8.
const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const stubCredits = {
  async resolve(slug: string) {
    return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "testauthor", wallet: AUTHOR_WALLET }] };
  },
};

const PUB: PublisherConfig = {
  id: "policied",
  originUrl: "http://origin-policied.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: stubCredits,
  licenseIdentity: "naulon:policied.example",
  seoAllowlist: ["legacybot"],
  crawlerPolicy: { allow: ["friendlybot"], block: ["nastybot", "bothways"], charge: ["stealthbot", "chargedsearch"] },
};
// Deliberate overlap fixture: "bothways" also in allow — block must win.
PUB.crawlerPolicy!.allow.push("bothways");
// "friendlybot" in both allow AND charge — allow must win over charge.
PUB.crawlerPolicy!.charge!.push("friendlybot");

const resolver: PublisherResolver = {
  async resolve(host) { return host === "policied.example" ? PUB : undefined; },
};
const app = createApp(resolver);

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })
  ) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function get(ua: string, extra: Record<string, string> = {}) {
  return app.request("/essays/piece", { headers: { host: "policied.example", "user-agent": ua, ...extra } });
}

test("blocked crawler gets 403 on a gateable route", async () => {
  const res = await get("Mozilla/5.0 (compatible; NastyBot/1.0)");
  assert.equal(res.status, 403);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /blocked/);
});

test("block beats payment — an X-PAYMENT header does not buy past a block", async () => {
  const res = await get("NastyBot/1.0", { "x-payment": "deadbeef" });
  assert.equal(res.status, 403, "payment intent must never bypass a publisher block");
});

test("block beats allow on overlap (fail-safe)", async () => {
  const res = await get("BothWays/2.0");
  assert.equal(res.status, 403);
});

test("allowed crawler reads free (merged with legacy seoAllowlist)", async () => {
  for (const ua of ["FriendlyBot/1.0", "LegacyBot/3.1"]) {
    const res = await get(ua);
    assert.equal(res.status, 200, `${ua} should read free`);
    assert.match(res.headers.get("x-naulon-verdict") ?? "", /human/);
  }
});

test("unlisted agent still pays — the stock 402 is untouched", async () => {
  const res = await get("GPTBot/1.0");
  assert.equal(res.status, 402);
});

test("browser-shaped human without a blocked fragment is untouched", async () => {
  const res = await app.request("/essays/piece", {
    headers: { host: "policied.example", "user-agent": "Mozilla/5.0 Firefox/128.0", accept: "text/html" },
  });
  assert.equal(res.status, 200);
});

test("block applies to gateable routes only — non-article passthrough unaffected", async () => {
  const res = await app.request("/about", { headers: { host: "policied.example", "user-agent": "NastyBot/1.0" } });
  assert.equal(res.status, 200, "non-article paths pass through even for a blocked UA");
});

test("a publisher WITHOUT crawlerPolicy behaves exactly as before (regression)", async () => {
  const bare: PublisherConfig = { ...PUB, id: "bare", crawlerPolicy: undefined };
  const app2 = createApp({ async resolve() { return bare; } });
  const r402 = await app2.request("/essays/piece", { headers: { host: "x", "user-agent": "GPTBot/1.0" } });
  assert.equal(r402.status, 402);
});

test("charge-listed crawler is tolled even when browser-shaped", async () => {
  const res = await app.request("/essays/piece", {
    headers: { host: "policied.example", "user-agent": "Mozilla/5.0 (compatible; StealthBot/1.0)", accept: "text/html" },
  });
  assert.equal(res.status, 402, "an explicitly-charged crawler must hit the toll, not the browser-shaped free path");
});

test("charge-listed crawler with ambiguous shape is tolled", async () => {
  const res = await app.request("/essays/piece", {
    headers: { host: "policied.example", "user-agent": "ChargedSearch/2.0" },
  });
  assert.equal(res.status, 402);
});

test("allow beats charge on overlap (allow checked first)", async () => {
  // "friendlybot" is in both allow AND charge — allow wins.
  const res = await app.request("/essays/piece", {
    headers: { host: "policied.example", "user-agent": "FriendlyBot/1.0" },
  });
  assert.equal(res.status, 200, "allow wins over charge");
});

test("absent charge list changes nothing (regression)", async () => {
  // A publisher with no charge list: known-agent UA still 402, browser UA still 200.
  const noCharge: PublisherConfig = { ...PUB, id: "nocharge", crawlerPolicy: { allow: [], block: [] } };
  const app3 = createApp({ async resolve() { return noCharge; } });
  const r402 = await app3.request("/essays/piece", {
    headers: { host: "x", "user-agent": "GPTBot/1.0" },
  });
  assert.equal(r402.status, 402, "known-agent UA must still be tolled without a charge list");
  const r200 = await app3.request("/essays/piece", {
    headers: { host: "x", "user-agent": "Mozilla/5.0 Firefox/128.0", accept: "text/html" },
  });
  assert.equal(r200.status, 200, "browser UA must still read free without a charge list");
});
