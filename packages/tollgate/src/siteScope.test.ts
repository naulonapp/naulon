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

// ── the extension allowlist, over real HTTP ───────────────────────────────────
// Third fixture: whole-site, with `pdf` and `json` opted into the toll. The point
// of the assertions below is the ORDER — discovery and control routes are refused
// before the allowlist is consulted, so opting into a type cannot starve the
// catalog agents buy from.

const FILES: PublisherConfig = {
  ...PUB,
  id: "files",
  gateScope: { mode: "site", excludePrefixes: ["legal"], includeExtensions: ["pdf", "json"] },
};
const files = createApp({ async resolve(host) { return host === "files.example" ? FILES : undefined; } });

function getFile(path: string, ua = "GPTBot") {
  return files.request(path, { headers: { host: "files.example", "user-agent": ua } });
}

test("site mode: an allowlisted extension answers 402", async () => {
  for (const p of ["/papers/quantum.pdf", "/papers/2026/quantum.pdf", "/data/prices.json"]) {
    const res = await getFile(p);
    assert.equal(res.status, 402, `${p} should toll`);
  }
});

test("site mode: a non-allowlisted asset stays free while the allowlist is on", async () => {
  for (const p of ["/app.css", "/bundle.js", "/logo.png", "/font.woff2"]) {
    const res = await getFile(p);
    assert.notEqual(res.status, 402, `${p} must stay free`);
  }
});

test("site mode: discovery and control stay free even when their extension is allowlisted", async () => {
  for (const p of ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/.well-known/x402"]) {
    const res = await getFile(p);
    assert.notEqual(res.status, 402, `${p} must stay free`);
  }
});

test("site mode: an excluded section stays free even for an allowlisted type", async () => {
  const res = await getFile("/legal/terms.pdf");
  assert.notEqual(res.status, 402);
});

test("site mode: humans read an allowlisted file free, forever", async () => {
  const res = await getFile("/papers/quantum.pdf", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
  assert.notEqual(res.status, 402);
});

test("site mode: the SAME .pdf is free without the allowlist (the differential)", async () => {
  // `get` drives PUB, which sets no includeExtensions. Same path, same gate, same
  // agent UA — the only difference is the field. Without this the four tests above
  // could pass on a gate that tolled every .pdf unconditionally.
  const free = await get("/papers/quantum.pdf");
  assert.notEqual(free.status, 402);
  const tolled = await getFile("/papers/quantum.pdf");
  assert.equal(tolled.status, 402);
});

test("site mode: WordPress and Hugo discovery stay free over HTTP with xml opted in", async () => {
  // The root-anchored matcher made /sitemap.xml free and /wp-sitemap.xml chargeable — on the
  // CMS naulon ships a plugin for. Paywalling a sitemap hides the catalog from the buyers the
  // toll exists to attract, so this is asserted on the wire, not just in the slug unit.
  const xml: PublisherConfig = {
    ...PUB,
    id: "xmlsite",
    gateScope: { mode: "site", excludePrefixes: [], includeExtensions: ["xml", "txt"] },
  };
  const app2 = createApp({ async resolve(host) { return host === "xml.example" ? xml : undefined; } });
  const get2 = (p: string) => app2.request(p, { headers: { host: "xml.example", "user-agent": "GPTBot" } });
  for (const p of ["/sitemap.xml", "/wp-sitemap.xml", "/wp-sitemap-posts-post-1.xml", "/post-sitemap.xml", "/index.xml", "/en/sitemap.xml", "/blog/feed.xml", "/llms.txt", "/ads.txt", "/robots.txt"]) {
    const res = await get2(p);
    assert.notEqual(res.status, 402, `${p} must stay free`);
  }
});
