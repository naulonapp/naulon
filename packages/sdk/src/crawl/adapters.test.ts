import { test } from "node:test";
import assert from "node:assert/strict";
import { rssAdapter } from "./adapters/rss.ts";
import { sitemapAdapter } from "./adapters/sitemap.ts";
import { wordpressAdapter } from "./adapters/wordpress.ts";
import { selectAdapter } from "./registry.ts";
import type { AdapterContext, CrawlConfig, Fetcher } from "./types.ts";

const ORIGIN = "https://site.com";

/** A fake Fetcher over a fixture map: path → body (200) or a status. Missing path → 404. */
function fakeFetch(fixtures: Record<string, string | { status: number; body?: string }>): Fetcher {
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(fixtures).find((k) => k === path || k === new URL(url).pathname);
    const hit = key !== undefined ? fixtures[key]! : undefined;
    const status = hit === undefined ? 404 : typeof hit === "string" ? 200 : hit.status;
    const body = hit === undefined ? "" : typeof hit === "string" ? hit : (hit.body ?? "");
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body;
      },
      async json() {
        return JSON.parse(body) as unknown;
      },
    };
  };
}

function ctx(fetch: Fetcher, over: Partial<CrawlConfig> = {}): AdapterContext {
  const config: CrawlConfig = { includeGlobs: [], excludeGlobs: [], authorWalletMap: {}, ...over };
  return { origin: ORIGIN, articlePrefixes: ["essays"], config, fetch };
}

/* ── RSS ─────────────────────────────────────────────────────────────────────── */

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <item><title>On Stillness</title><link>https://site.com/essays/on-stillness</link>
    <dc:creator>Jane Roe</dc:creator><pubDate>Wed, 02 Jul 2025 00:00:00 GMT</pubDate></item>
  <item><title>Off Topic</title><link>https://site.com/about/x</link><author>a@b.com (Bob)</author></item>
</channel></rss>`;

test("rss detect true when a conventional feed parses", async () => {
  assert.equal(await rssAdapter.detect(ctx(fakeFetch({ "/feed": RSS }))), true);
});

test("rss detect false when no feed is present", async () => {
  assert.equal(await rssAdapter.detect(ctx(fakeFetch({}))), false);
});

test("rss discover yields on-prefix articles with author + date, drops off-prefix", async () => {
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/feed": RSS })));
  assert.equal(arts.length, 1); // /about/x has no essays prefix → dropped
  const a = arts[0]!;
  assert.equal(a.slug, "on-stillness");
  assert.equal(a.title, "On Stillness");
  assert.deepEqual(a.authors, [{ name: "Jane Roe" }]);
  assert.equal(a.publishedAt, new Date("Wed, 02 Jul 2025 00:00:00 GMT").toISOString());
});

test("rss parses Atom entries + author/name + rel=alternate link", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>A</title><link rel="alternate" href="https://site.com/essays/a"/>
      <author><name>Ann</name></author><published>2025-01-01T00:00:00Z</published></entry>
  </feed>`;
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/atom.xml": atom })));
  assert.equal(arts.length, 1);
  assert.equal(arts[0]!.slug, "a");
  assert.deepEqual(arts[0]!.authors, [{ name: "Ann" }]);
});

test("rss auto-detects the WordPress /feed/ trailing-slash path (no redirect chasing)", async () => {
  // WordPress canonicalizes /feed → /feed/ with a 301; the fetcher won't chase it, so the probe
  // must try /feed/ directly. Model /feed as a 301 (not-ok) and the real feed at /feed/.
  const fetch = fakeFetch({ "/feed": { status: 301 }, "/feed/": RSS });
  assert.equal(await rssAdapter.detect(ctx(fetch)), true);
  const arts = await rssAdapter.discover(ctx(fetch));
  assert.equal(arts.length, 1);
  assert.equal(arts[0]!.slug, "on-stillness");
});

test("rss honors an explicit feedUrl override on the same origin", async () => {
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/custom-feed": RSS }), { feedUrl: "https://site.com/custom-feed" }));
  assert.equal(arts.length, 1);
});

/* ── sitemap ─────────────────────────────────────────────────────────────────── */

const SITEMAP = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/essays/a</loc><lastmod>2025-03-01</lastmod></url>
  <url><loc>https://site.com/essays/b</loc></url>
  <url><loc>https://site.com/about</loc></url>
</urlset>`;

test("sitemap discover yields on-prefix URLs only, no authors, lastmod as date", async () => {
  const arts = await sitemapAdapter.discover(ctx(fakeFetch({ "/sitemap.xml": SITEMAP })));
  assert.deepEqual(arts.map((a) => a.slug).sort(), ["a", "b"]); // /about dropped
  assert.deepEqual(arts.find((a) => a.slug === "a")!.authors, []);
  assert.equal(arts.find((a) => a.slug === "a")!.publishedAt, new Date("2025-03-01").toISOString());
});

test("sitemap recurses a sitemap index (bounded)", async () => {
  const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://site.com/sm-1.xml</loc></sitemap></sitemapindex>`;
  const arts = await sitemapAdapter.discover(ctx(fakeFetch({ "/sitemap.xml": index, "/sm-1.xml": SITEMAP })));
  assert.deepEqual(arts.map((a) => a.slug).sort(), ["a", "b"]);
});

test("sitemap excludeGlobs carve URLs back out", async () => {
  const arts = await sitemapAdapter.discover(
    ctx(fakeFetch({ "/sitemap.xml": SITEMAP }), { excludeGlobs: ["/essays/b"] }),
  );
  assert.deepEqual(arts.map((a) => a.slug), ["a"]);
});

/* ── WordPress ───────────────────────────────────────────────────────────────── */

const WP_POSTS = JSON.stringify([
  {
    link: "https://site.com/essays/hello",
    date_gmt: "2025-05-01T12:00:00",
    title: { rendered: "Hello" },
    _embedded: { author: [{ id: 7, name: "Wanda" }] },
  },
]);

test("wordpress detect true when /wp-json returns a JSON array", async () => {
  assert.equal(await wordpressAdapter.detect(ctx(fakeFetch({ "/wp-json/wp/v2/posts": "[]" }))), true);
});

test("wordpress discover reads real author objects + UTC date_gmt", async () => {
  const arts = await wordpressAdapter.discover(ctx(fakeFetch({ "/wp-json/wp/v2/posts": WP_POSTS })));
  assert.equal(arts.length, 1);
  const a = arts[0]!;
  assert.equal(a.slug, "hello");
  assert.equal(a.title, "Hello");
  assert.deepEqual(a.authors, [{ name: "Wanda", externalId: "7" }]);
  assert.equal(a.publishedAt, new Date("2025-05-01T12:00:00Z").toISOString());
});

test("wordpress discover throws loudly when even the bare first page fails (not a silent empty draft)", async () => {
  // detect() would have passed on the same endpoint, so a page-1 failure is a real fault. When
  // BOTH the _embed and the bare fallback fail, it MUST surface, not draft nothing in silence.
  const boom: Fetcher = async () => {
    throw new Error("crawl fetcher: timeout after 15000ms");
  };
  await assert.rejects(() => wordpressAdapter.discover(ctx(boom)), /first page.*even without _embed/i);
});

test("wordpress discover falls back to a BARE page when _embed is too heavy (catalog survives, no authors)", async () => {
  // TechCrunch's real behavior: the _embed page times out; the bare listing is fast. The catalog
  // must still be captured — only author names are lost (→ defaultWallet), never the articles.
  const bare = JSON.stringify([
    { link: "https://site.com/essays/heavy-a", title: { rendered: "Heavy A" }, author: 42 },
    { link: "https://site.com/essays/heavy-b", title: { rendered: "Heavy B" }, author: 42 },
  ]);
  const fetch: Fetcher = async (url) => {
    const embed = new URL(url).searchParams.has("_embed");
    if (embed) throw new Error("crawl fetcher: timeout after 15000ms"); // _embed too heavy
    return { ok: true, status: 200, async text() { return bare; }, async json() { return JSON.parse(bare) as unknown; } };
  };
  const arts = await wordpressAdapter.discover(ctx(fetch));
  assert.deepEqual(arts.map((a) => a.slug), ["heavy-a", "heavy-b"]); // catalog captured
  assert.deepEqual(arts[0]!.authors, []); // bare page → no author names → resolves to defaultWallet
});

test("wordpress discover keeps earlier pages when a LATER page fails (embed + bare both)", async () => {
  // Page 1 yields a full page (so pagination continues); page 2 fails both modes → keep page 1.
  const page1 = JSON.stringify(
    Array.from({ length: 50 }, (_, i) => ({
      link: `https://site.com/essays/p${i}`,
      title: { rendered: `P${i}` },
      _embedded: { author: [{ id: 1, name: "A" }] },
    })),
  );
  let calls = 0;
  const fetch: Fetcher = async (url) => {
    calls++;
    const page = new URL(url).searchParams.get("page");
    if (page === "1") {
      return { ok: true, status: 200, async text() { return page1; }, async json() { return JSON.parse(page1) as unknown; } };
    }
    throw new Error("crawl fetcher: timeout after 15000ms"); // page 2: both _embed and bare fail
  };
  const arts = await wordpressAdapter.discover(ctx(fetch));
  assert.equal(arts.length, 50); // page 1 kept despite page 2 failing
  assert.equal(calls, 3); // page-1 embed, then page-2 embed + page-2 bare retry, then stop
});

/* ── registry ────────────────────────────────────────────────────────────────── */

test("selectAdapter prefers WordPress (richest) over rss/sitemap when all detect", async () => {
  const c = ctx(fakeFetch({ "/wp-json/wp/v2/posts": "[]", "/feed": RSS, "/sitemap.xml": SITEMAP }));
  const chosen = await selectAdapter(c);
  assert.equal(chosen?.id, "wordpress");
});

test("selectAdapter falls to rss over sitemap when no WordPress", async () => {
  const c = ctx(fakeFetch({ "/feed": RSS, "/sitemap.xml": SITEMAP }));
  assert.equal((await selectAdapter(c))?.id, "rss");
});

test("selectAdapter returns null when nothing detects", async () => {
  assert.equal(await selectAdapter(ctx(fakeFetch({}))), null);
});
