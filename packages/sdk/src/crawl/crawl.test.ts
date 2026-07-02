import { test } from "node:test";
import assert from "node:assert/strict";
import { runCrawl } from "./crawl.ts";
import type { CrawlConfig, Fetcher } from "./types.ts";

const W_A = "0x1111111111111111111111111111111111111111";

function fakeFetch(fixtures: Record<string, string>): Fetcher {
  return async (url) => {
    const path = new URL(url).pathname;
    const body = fixtures[path];
    const status = body === undefined ? 404 : 200;
    return { ok: status === 200, status, async text() { return body ?? ""; }, async json() { return JSON.parse(body ?? "null"); } };
  };
}
function cfg(over: Partial<CrawlConfig> = {}): CrawlConfig {
  return { includeGlobs: [], excludeGlobs: [], authorWalletMap: {}, ...over };
}

const RSS = `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <item><title>A</title><link>https://s.com/essays/a</link><dc:creator>Jane</dc:creator></item>
  <item><title>B</title><link>https://s.com/essays/b</link><dc:creator>Nemo</dc:creator></item>
</channel></rss>`;

test("runCrawl auto-detects the adapter, discovers, and merges custody-free", async () => {
  const r = await runCrawl({
    origin: "https://s.com",
    articlePrefixes: ["essays"],
    config: cfg({ authorWalletMap: { Jane: W_A } }), // Nemo unmapped, no defaultWallet
    existing: {},
    fetch: fakeFetch({ "/feed": RSS }),
  });
  assert.equal(r.adapterId, "rss");
  assert.equal(r.discovered, 2);
  assert.deepEqual(r.added, ["a"]);
  assert.deepEqual(r.unmapped, [{ slug: "b", author: "Nemo" }]);
  assert.equal(r.credits["a"]!.contributors[0]!.wallet, W_A);
});

test("runCrawl returns adapterId null when nothing detects (no throw)", async () => {
  const r = await runCrawl({
    origin: "https://s.com",
    articlePrefixes: ["essays"],
    config: cfg(),
    existing: {},
    fetch: fakeFetch({}),
  });
  assert.equal(r.adapterId, null);
  assert.equal(r.discovered, 0);
  assert.deepEqual(r.added, []);
});

test("runCrawl honors a forced adapter id (skips detect)", async () => {
  const r = await runCrawl({
    origin: "https://s.com",
    articlePrefixes: ["essays"],
    config: cfg({ defaultWallet: W_A }),
    existing: {},
    fetch: fakeFetch({ "/sitemap.xml": `<urlset><url><loc>https://s.com/essays/z</loc></url></urlset>` }),
    forceAdapterId: "sitemap",
  });
  assert.equal(r.adapterId, "sitemap");
  assert.deepEqual(r.added, ["z"]);
});

test("runCrawl throws on an unknown forced adapter id", async () => {
  await assert.rejects(
    () =>
      runCrawl({
        origin: "https://s.com",
        articlePrefixes: ["essays"],
        config: cfg(),
        existing: {},
        fetch: fakeFetch({}),
        // @ts-expect-error — testing the runtime guard for a bad id
        forceAdapterId: "ghost",
      }),
    /unknown adapter/,
  );
});
