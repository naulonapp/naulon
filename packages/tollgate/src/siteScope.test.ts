/**
 * gateScope site mode: every path tolls (slug = the full decoded pathname),
 * with discovery surfaces, static assets, and gate control routes hard-excluded
 * — tolling discovery would starve the catalog agents buy from. Publisher
 * excludePrefixes add free sections on top. Absent / prefixes mode stays
 * byte-identical to the stock articlePrefixes matcher.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-sitescope-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const stubCredits = {
  async resolve(slug: string) {
    return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "testauthor", wallet: AUTHOR_WALLET }] };
  },
};

const PUB: PublisherConfig = {
  id: "sitewide",
  originUrl: "http://origin-sitewide.local",
  articlePrefixes: [],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: stubCredits,
  licenseIdentity: "naulon:site.example",
  gateScope: { mode: "site", excludePrefixes: ["legal"] },
};

const app = createApp({ async resolve(host) { return host === "site.example" ? PUB : undefined; } });

// Second fixture: gateScope absent + stock prefixes — the regression pin.
const BARE: PublisherConfig = {
  ...PUB,
  id: "bare",
  gateScope: undefined,
  articlePrefixes: ["essays"],
};
const bare = createApp({ async resolve() { return BARE; } });

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })
  ) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function get(path: string, ua = "GPTBot") {
  return app.request(path, { headers: { host: "site.example", "user-agent": ua } });
}

test("site mode tolls the root and single-segment pages", async () => {
  for (const p of ["/", "/about", "/essays/piece", "/a/b/c"]) {
    const res = await get(p);
    assert.equal(res.status, 402, `${p} should toll in site mode`);
  }
});

test("site mode keeps discovery + control + assets free", async () => {
  for (const p of ["/robots.txt", "/sitemap.xml", "/sitemap-0.xml", "/rss.xml", "/feed", "/atom.xml",
                   "/favicon.ico", "/app.css", "/bundle.js", "/logo.png", "/font.woff2",
                   "/.well-known/x402", "/licenses/abc"]) {
    const res = await get(p);
    assert.notEqual(res.status, 402, `${p} must stay un-tolled`);
  }
});

test("publisher excludePrefixes read free", async () => {
  const res = await get("/legal/terms");
  assert.equal(res.status, 200);
});

test("browser-shaped human reads free in site mode", async () => {
  const res = await app.request("/about", {
    headers: { host: "site.example", "user-agent": "Mozilla/5.0 Firefox/128.0", accept: "text/html" },
  });
  assert.equal(res.status, 200);
});

test("prefixes mode (and absent gateScope) is byte-identical to today (regression)", async () => {
  const r402 = await bare.request("/essays/piece", { headers: { host: "x", "user-agent": "GPTBot" } });
  assert.equal(r402.status, 402, "prefix-matched article must still toll");
  const r200 = await bare.request("/about", { headers: { host: "x", "user-agent": "GPTBot" } });
  assert.equal(r200.status, 200, "non-prefix path must still pass through free");
});
