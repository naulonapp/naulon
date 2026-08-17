import { test } from "node:test";
import assert from "node:assert/strict";
import { rssAdapter } from "./adapters/rss.ts";
import { sitemapAdapter } from "./adapters/sitemap.ts";
import { wordpressAdapter } from "./adapters/wordpress.ts";
import { assertConformance, runConformance, type ConformanceFixtures } from "./testing.ts";
import type { ArticleCandidate, SourceAdapter } from "./types.ts";

const ORIGIN = "https://site.com";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>One</title><link>https://site.com/articles/one</link>
    <description>A teaser.</description><pubDate>Wed, 02 Jul 2025 00:00:00 GMT</pubDate></item>
</channel></rss>`;

const SITEMAP = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/articles/one</loc><lastmod>2025-03-01</lastmod></url>
</urlset>`;

const WP_POSTS = JSON.stringify([
  {
    link: "https://site.com/articles/one",
    date_gmt: "2025-05-01T12:00:00",
    title: { rendered: "One" },
    excerpt: { rendered: "<p>A teaser.</p>" },
    _embedded: { author: [{ id: 7, name: "Wanda" }] },
  },
]);

/* ── the adapters this package ships must pass their own contract ────────────── */

test("rssAdapter conforms", async () => {
  assertConformance(await runConformance(rssAdapter, { origin: ORIGIN, routes: { "/feed": RSS } }));
});

test("sitemapAdapter conforms", async () => {
  assertConformance(await runConformance(sitemapAdapter, { origin: ORIGIN, routes: { "/sitemap.xml": SITEMAP } }));
});

test("wordpressAdapter conforms", async () => {
  assertConformance(
    await runConformance(wordpressAdapter, { origin: ORIGIN, routes: { "/wp-json/wp/v2/posts": WP_POSTS } }),
  );
});

/* ── and the kit must actually CATCH a bad one ───────────────────────────────── */
//
// A conformance suite that passes everything is worse than none: it certifies nothing while
// reading like proof. Each case below is a real way an adapter goes wrong, and each must fail.

const OK_FIXTURES: ConformanceFixtures = { origin: ORIGIN, routes: { "/feed": RSS } };

/** Build a minimal adapter that discovers exactly the candidates it is handed. */
function adapterYielding(candidates: unknown[]): SourceAdapter<string> {
  return {
    id: "under-test",
    rank: 1,
    async detect() {
      return true;
    },
    async discover() {
      return candidates as ArticleCandidate[];
    },
  };
}

async function failuresOf(adapter: SourceAdapter<string>, fixtures = OK_FIXTURES): Promise<string[]> {
  const report = await runConformance(adapter, fixtures);
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

test("catches an adapter that keys its own articles", async () => {
  const failed = await failuresOf(adapterYielding([{ slug: "one", url: `${ORIGIN}/articles/one`, title: "One", authors: [] }]));
  assert.ok(failed.includes("candidates carry no slug — keying belongs to the orchestrator"), failed.join(", "));
});

test("catches an adapter that emits an off-origin URL", async () => {
  const failed = await failuresOf(adapterYielding([{ url: "https://elsewhere.example/one", title: "One", authors: [] }]));
  assert.ok(failed.includes("every candidate URL is absolute and on the verified origin"), failed.join(", "));
});

test("catches an adapter that puts a wallet in the catalog plane", async () => {
  const failed = await failuresOf(
    adapterYielding([
      {
        url: `${ORIGIN}/articles/one`,
        title: "One",
        authors: [{ name: "Wanda", externalId: "0x1234567890abcdef1234567890abcdef12345678" }],
      },
    ]),
  );
  assert.ok(failed.includes("no candidate carries a wallet — money is never inferred"), failed.join(", "));
});

test("catches an adapter that throws when the origin is unreachable", async () => {
  const brittle: SourceAdapter<string> = {
    id: "brittle",
    rank: 1,
    async detect(ctx) {
      await ctx.fetch(`${ORIGIN}/feed`); // no try/catch — a dead origin takes the whole crawl down
      return true;
    },
    async discover() {
      return [];
    },
  };
  const failed = await failuresOf(brittle);
  assert.ok(failed.includes("detect never throws when the network is unreachable"), failed.join(", "));
});

test("catches an adapter that reaches another host through the origin fetcher", async () => {
  const leaky: SourceAdapter<string> = {
    id: "leaky",
    rank: 1,
    async detect() {
      return true;
    },
    async discover(ctx) {
      await ctx.fetch("https://metadata.internal/latest"); // the SSRF shape, in one line
      return [{ url: `${ORIGIN}/articles/one`, title: "One", authors: [] }];
    },
  };
  const failed = await failuresOf(leaky);
  assert.ok(failed.includes("ctx.fetch was used only for the verified origin"), failed.join(", "));
});

test("catches an adapter that declares a wildcard off-origin allowlist", async () => {
  const wild: SourceAdapter<string> = {
    ...adapterYielding([{ url: `${ORIGIN}/articles/one`, title: "One", authors: [] }]),
    requires: { offOrigin: ["*.googleapis.com"] },
  };
  const failed = await failuresOf(wild);
  assert.ok(failed.includes("declared off-origin hosts are bare hostnames"), failed.join(", "));
});

test("catches an adapter that finds nothing on its own happy path", async () => {
  const failed = await failuresOf(adapterYielding([]));
  assert.ok(failed.includes("discover finds candidates on the happy-path fixture"), failed.join(", "));
});

test("assertConformance names every failure, not just the first", async () => {
  const report = await runConformance(adapterYielding([{ slug: "x", url: "https://elsewhere.example/x", title: "X", authors: [] }]), OK_FIXTURES);
  assert.equal(report.passed, false);
  assert.throws(
    () => assertConformance(report),
    (e: Error) => /carry no slug/.test(e.message) && /on the verified origin/.test(e.message),
  );
});

test("off-origin fixtures match on host+path, so a query string need not be reproduced", async () => {
  const platform: SourceAdapter<string> = {
    id: "platform",
    rank: 1,
    requires: { offOrigin: ["api.example.com"] },
    async detect() {
      return true;
    },
    async discover(ctx) {
      // A real platform API carries a key and a field mask whose order the fixture cannot know.
      await ctx.capabilities?.offOriginFetch?.("https://api.example.com/v1/posts?key=k&fields=a,b");
      return [{ url: `${ORIGIN}/articles/one`, title: "One", authors: [] }];
    },
  };
  assertConformance(
    await runConformance(platform, {
      ...OK_FIXTURES,
      offOriginRoutes: { "https://api.example.com/v1/posts": "[]" },
    }),
  );
});

test("a granted off-origin adapter passes when it stays inside its allowlist", async () => {
  const platform: SourceAdapter<string> = {
    id: "platform",
    rank: 1,
    requires: { secret: true, offOrigin: ["api.example.com"] },
    async detect() {
      return true;
    },
    async discover(ctx) {
      await ctx.capabilities?.offOriginFetch?.("https://api.example.com/v1/posts");
      return [{ url: `${ORIGIN}/articles/one`, title: "One", authors: [] }];
    },
  };
  assertConformance(
    await runConformance(platform, {
      ...OK_FIXTURES,
      capabilities: { secret: "sk_test" },
      offOriginRoutes: { "https://api.example.com/v1/posts": "[]" },
    }),
  );
});
