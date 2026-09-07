import { test } from "node:test";
import assert from "node:assert/strict";
import { rssAdapter } from "./adapters/rss.ts";
import { sitemapAdapter } from "./adapters/sitemap.ts";
import { wordpressAdapter } from "./adapters/wordpress.ts";
import { ADAPTERS, canRun, selectAdapter } from "./registry.ts";
import type { AdapterContext, CrawlConfig, Fetcher, SourceAdapter } from "./types.ts";

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
    <description><![CDATA[<p>A short  teaser.</p>]]></description>
    <dc:creator>Jane Roe</dc:creator><pubDate>Wed, 02 Jul 2025 00:00:00 GMT</pubDate></item>
  <item><title>Off Topic</title><link>https://site.com/about/x</link><author>a@b.com (Bob)</author></item>
</channel></rss>`;

test("rss detect true when a conventional feed parses", async () => {
  assert.equal(await rssAdapter.detect(ctx(fakeFetch({ "/feed": RSS }))), true);
});

test("rss detect false when no feed is present", async () => {
  assert.equal(await rssAdapter.detect(ctx(fakeFetch({}))), false);
});

test("rss discover yields every feed item as a candidate, with author + teaser + date", async () => {
  // Off-prefix filtering is NOT the adapter's job any more — it emits what the feed states and
  // `runCrawl` drops what it cannot key. So /about/x is present here and gone after keying.
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/feed": RSS })));
  assert.equal(arts.length, 2);
  const a = arts.find((c) => c.url.endsWith("/essays/on-stillness"))!;
  assert.equal(a.title, "On Stillness");
  assert.equal(a.summary, "A short teaser."); // tags stripped, whitespace collapsed
  assert.deepEqual(a.authors, [{ name: "Jane Roe" }]);
  assert.equal(a.publishedAt, new Date("Wed, 02 Jul 2025 00:00:00 GMT").toISOString());
  assert.equal("slug" in a, false); // keying belongs to the orchestrator
});

test("rss parses Atom entries + author/name + rel=alternate link", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>A</title><link rel="alternate" href="https://site.com/essays/a"/>
      <author><name>Ann</name></author><published>2025-01-01T00:00:00Z</published></entry>
  </feed>`;
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/atom.xml": atom })));
  assert.equal(arts.length, 1);
  assert.equal(arts[0]!.url, "https://site.com/essays/a");
  assert.deepEqual(arts[0]!.authors, [{ name: "Ann" }]);
});

test("rss auto-detects the WordPress /feed/ trailing-slash path (no redirect chasing)", async () => {
  // WordPress canonicalizes /feed → /feed/ with a 301; the fetcher won't chase it, so the probe
  // must try /feed/ directly. Model /feed as a 301 (not-ok) and the real feed at /feed/.
  const fetch = fakeFetch({ "/feed": { status: 301 }, "/feed/": RSS });
  assert.equal(await rssAdapter.detect(ctx(fetch)), true);
  const arts = await rssAdapter.discover(ctx(fetch));
  assert.equal(arts.length, 2);
  assert.ok(arts.some((c) => c.url.endsWith("/essays/on-stillness")));
});

test("rss honors an explicit feedUrl override on the same origin", async () => {
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/custom-feed": RSS }), { feedUrl: "https://site.com/custom-feed" }));
  assert.equal(arts.length, 2);
});

/* ── sitemap ─────────────────────────────────────────────────────────────────── */

const SITEMAP = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/essays/a</loc><lastmod>2025-03-01</lastmod></url>
  <url><loc>https://site.com/essays/b</loc></url>
  <url><loc>https://site.com/about</loc></url>
</urlset>`;

test("sitemap discover yields glob-passing URLs, no authors, lastmod as date", async () => {
  // Globs stay the adapter's concern (a sitemap lists every URL); keying does not, so /about
  // survives here and is dropped by `runCrawl` as unkeyable.
  const arts = await sitemapAdapter.discover(ctx(fakeFetch({ "/sitemap.xml": SITEMAP })));
  assert.deepEqual(arts.map((a) => a.url).sort(), [
    "https://site.com/about",
    "https://site.com/essays/a",
    "https://site.com/essays/b",
  ]);
  const a = arts.find((c) => c.url.endsWith("/essays/a"))!;
  assert.deepEqual(a.authors, []);
  assert.equal(a.publishedAt, new Date("2025-03-01").toISOString());
});

test("sitemap recurses a sitemap index (bounded)", async () => {
  const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://site.com/sm-1.xml</loc></sitemap></sitemapindex>`;
  const arts = await sitemapAdapter.discover(ctx(fakeFetch({ "/sitemap.xml": index, "/sm-1.xml": SITEMAP })));
  assert.deepEqual(arts.map((a) => new URL(a.url).pathname).sort(), ["/about", "/essays/a", "/essays/b"]);
});

test("sitemap excludeGlobs carve URLs back out", async () => {
  const arts = await sitemapAdapter.discover(
    ctx(fakeFetch({ "/sitemap.xml": SITEMAP }), { excludeGlobs: ["/essays/b"] }),
  );
  assert.deepEqual(arts.map((a) => new URL(a.url).pathname), ["/essays/a", "/about"]);
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
  assert.equal(a.url, "https://site.com/essays/hello");
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
  assert.deepEqual(arts.map((a) => new URL(a.url).pathname), ["/essays/heavy-a", "/essays/heavy-b"]);
  assert.deepEqual(arts[0]!.authors, []); // /users answered with posts, so no id→name join → defaultWallet
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

test("wordpress recovers author names from /users when the page is bare (the id join)", async () => {
  // The `_embed`-timeout path used to yield a catalog with NO authors at all, so every article
  // landed unmapped on a human's desk. A bare listing still carries `author` as a numeric id;
  // joining the origin's own user directory turns that back into a name.
  const bare = JSON.stringify([
    { link: "https://site.com/essays/one", title: { rendered: "One" }, author: 42 },
    { link: "https://site.com/essays/two", title: { rendered: "Two" }, author: 42 },
  ]);
  const users = JSON.stringify([{ id: 42, name: "Wanda Maxima", slug: "wanda" }]);
  let userCalls = 0;
  const fetch: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/users")) {
      userCalls++;
      return { ok: true, status: 200, async text() { return users; }, async json() { return JSON.parse(users) as unknown; } };
    }
    if (u.searchParams.has("_embed")) throw new Error("crawl fetcher: timeout after 15000ms");
    return { ok: true, status: 200, async text() { return bare; }, async json() { return JSON.parse(bare) as unknown; } };
  };
  const arts = await wordpressAdapter.discover(ctx(fetch));
  assert.deepEqual(arts.map((a) => a.authors[0]?.name), ["Wanda Maxima", "Wanda Maxima"]);
  assert.equal(arts[0]!.authors[0]!.externalId, "42");
  assert.equal(userCalls, 1); // memoized — one directory read per crawl, not one per post
});

test("wordpress falls through quietly when /users is disabled (privacy plugins)", async () => {
  // A 401 here is normal on a locked-down site. It must cost the author names, never the catalog.
  const bare = JSON.stringify([{ link: "https://site.com/essays/one", title: { rendered: "One" }, author: 42 }]);
  const fetch: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/users")) return { ok: false, status: 401, async text() { return ""; }, async json() { return {}; } };
    if (u.searchParams.has("_embed")) throw new Error("crawl fetcher: timeout after 15000ms");
    return { ok: true, status: 200, async text() { return bare; }, async json() { return JSON.parse(bare) as unknown; } };
  };
  const arts = await wordpressAdapter.discover(ctx(fetch));
  assert.equal(arts.length, 1);
  assert.deepEqual(arts[0]!.authors, []); // no name → resolution falls to defaultWallet
});

test("wordpress never reads /users when _embed works", async () => {
  let userCalls = 0;
  const fetch: Fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/users")) userCalls++;
    return { ok: true, status: 200, async text() { return WP_POSTS; }, async json() { return JSON.parse(WP_POSTS) as unknown; } };
  };
  await wordpressAdapter.discover(ctx(fetch));
  assert.equal(userCalls, 0); // lazy: a healthy site pays nothing for the ladder
});

/* ── capabilities ────────────────────────────────────────────────────────────── */

/** A stand-in for the kind of adapter this package deliberately does not ship. */
const keyedAdapter: SourceAdapter<"keyed"> = {
  id: "keyed",
  rank: 500, // richest — so if it is ever selectable, it WILL be selected
  requires: { secret: true },
  async detect() {
    return true;
  },
  async discover() {
    return [];
  },
};

test("canRun refuses an adapter whose requirements the host cannot grant", () => {
  assert.equal(canRun(keyedAdapter, undefined), false);
  assert.equal(canRun(keyedAdapter, {}), false);
  assert.equal(canRun(keyedAdapter, { secret: "sk_test" }), true);
  assert.equal(canRun(rssAdapter, undefined), true); // requires nothing
});

test("selectAdapter never probes an adapter the host cannot satisfy", async () => {
  // The point of the filter: a front-door with no secret store cannot select a keyed adapter
  // even when it out-ranks everything and detects unconditionally.
  let probed = false;
  const spy: SourceAdapter<"keyed"> = { ...keyedAdapter, async detect() { probed = true; return true; } };
  const c = ctx(fakeFetch({ "/feed": RSS }));
  const chosen = await selectAdapter(c, [spy, rssAdapter as unknown as SourceAdapter<"keyed">]);
  assert.equal(chosen?.id, "rss");
  assert.equal(probed, false); // filtered out before detect — no fetch, no log, no half-run
});

test("selectAdapter runs a keyed adapter once the host grants the secret", async () => {
  const c: AdapterContext = { ...ctx(fakeFetch({})), capabilities: { secret: "sk_test" } };
  const chosen = await selectAdapter(c, [keyedAdapter]);
  assert.equal(chosen?.id, "keyed");
});

test("selectAdapter tries the preferred id first, then falls back to rank order", async () => {
  // A host whose user named their platform in a form: honor it, but never let a wrong answer
  // mean "discovered nothing".
  const c = ctx(fakeFetch({ "/feed": RSS, "/sitemap.xml": SITEMAP }));
  assert.equal((await selectAdapter(c, ADAPTERS, "sitemap"))?.id, "sitemap");
  assert.equal((await selectAdapter(c, ADAPTERS, "wordpress"))?.id, "rss"); // preferred doesn't detect
});

/* ── the FILES pass: what `/wp/v2/posts` and a bare feed structurally cannot see ──────────────
 *
 * A publisher who ticks `pdf` in the portal is opting that extension in to the toll
 * (`gateScope.includeExtensions`). Until this landed only the sitemap adapter ever emitted a
 * non-HTML URL, so on a WordPress or RSS catalogue the PDF was discovered by nobody: `quote()`
 * found no credits and the file served free forever, with the dashboard reporting the site as
 * configured. These tests pin both halves — that the files are found when opted in, and that
 * NOTHING changes (not one extra request) when they are not. */

/** A fetch recorder over the same fixture map, so "never fetched" is measured, not promised. */
function recordingFetch(fixtures: Record<string, string | { status: number; body?: string }>) {
  const urls: string[] = [];
  const inner = fakeFetch(fixtures);
  const fetch: Fetcher = async (url, init) => {
    urls.push(url);
    return inner(url, init);
  };
  return { fetch, urls };
}

const WP_MEDIA_APPLICATION = JSON.stringify([
  {
    source_url: "https://site.com/wp-content/uploads/2026/09/rssistan-report.pdf",
    date_gmt: "2026-09-01T09:00:00",
    title: { rendered: "Rssistan Report" },
    author: 7,
  },
  // Same coarse bucket, wrong extension — WordPress's `media_type` is deliberately coarse, so the
  // extension match is what keeps a .docx out of a `pdf` publisher's catalogue.
  { source_url: "https://site.com/wp-content/uploads/2026/09/minutes.docx", author: 7 },
  // An attachment page with no file behind it is skipped rather than staging the HTML `link`.
  { date_gmt: "2026-09-01T09:00:00", title: { rendered: "orphan" }, author: 7 },
]);

const WP_USERS = JSON.stringify([{ id: 7, name: "Wanda" }]);

test("wordpress: with no extensions opted in, the media library is never even requested", async () => {
  const { fetch, urls } = recordingFetch({ "/wp-json/wp/v2/posts": WP_POSTS, "/wp-json/wp/v2/media": WP_MEDIA_APPLICATION });
  const arts = await wordpressAdapter.discover(ctx(fetch));
  assert.equal(arts.length, 1, "posts only — byte-for-byte the old behaviour");
  assert.equal(urls.some((u) => u.includes("/media")), false, "not one extra request");
});

test("wordpress: an opted-in extension is discovered from the media library, uploader and all", async () => {
  const { fetch, urls } = recordingFetch({
    "/wp-json/wp/v2/posts": WP_POSTS,
    "/wp-json/wp/v2/media": WP_MEDIA_APPLICATION,
    "/wp-json/wp/v2/users": WP_USERS,
  });
  const arts = await wordpressAdapter.discover(ctx(fetch, { includeExtensions: ["pdf"] }));
  const pdf = arts.find((c) => c.url.endsWith(".pdf"));
  assert.ok(pdf, "the PDF a WordPress crawl could never see before");
  assert.equal(pdf.title, "Rssistan Report");
  assert.deepEqual(pdf.authors, [{ name: "Wanda", externalId: "7" }], "the uploader is a MAP KEY, never a wallet");
  assert.equal(pdf.publishedAt, new Date("2026-09-01T09:00:00Z").toISOString());
  assert.equal(arts.some((c) => c.url.endsWith(".docx")), false, "coarse bucket, exact extension match");
  assert.equal(arts.length, 2, "the post plus the file — additive, never a replacement");
  // `pdf` buckets to `application`; the text bucket is not asked for.
  assert.equal(urls.some((u) => u.includes("media_type=text")), false);
});

test("wordpress: a media library that is disabled costs the crawl nothing (posts still returned)", async () => {
  const { fetch } = recordingFetch({ "/wp-json/wp/v2/posts": WP_POSTS }); // /media → 404
  const arts = await wordpressAdapter.discover(ctx(fetch, { includeExtensions: ["pdf"] }));
  assert.equal(arts.length, 1, "a partial catalogue beats losing the posts over an attachment");
});

test("wordpress: a text-bucket extension asks the text bucket, and only that one", async () => {
  const { fetch, urls } = recordingFetch({ "/wp-json/wp/v2/posts": WP_POSTS });
  await wordpressAdapter.discover(ctx(fetch, { includeExtensions: ["xml"] }));
  assert.equal(urls.some((u) => u.includes("media_type=text")), true);
  assert.equal(urls.some((u) => u.includes("media_type=application")), false);
});

const RSS_WITH_FILES = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <item><title>On Stillness</title><link>https://site.com/essays/on-stillness</link>
    <author>a@b.com (Jane Roe)</author>
    <enclosure url="https://site.com/files/stillness.pdf" length="1" type="application/pdf"/>
    <enclosure url="https://site.com/files/reading.mp3" length="1" type="audio/mpeg"/>
    <media:content url="https://site.com/files/data.json"/></item>
</channel></rss>`;

test("rss: enclosures are dropped unless the publisher opted their extension in", async () => {
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/feed": RSS_WITH_FILES })));
  assert.deepEqual(arts.map((c) => c.url), ["https://site.com/essays/on-stillness"]);
});

test("rss: an opted-in enclosure is staged beside its item, inheriting its authors and date", async () => {
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/feed": RSS_WITH_FILES }), { includeExtensions: ["pdf", "json"] }));
  assert.deepEqual(arts.map((c) => c.url), [
    "https://site.com/essays/on-stillness",
    "https://site.com/files/stillness.pdf",
    "https://site.com/files/data.json", // Media RSS `<media:content url>` counts too
  ]);
  const pdf = arts[1]!;
  assert.equal(pdf.title, "stillness.pdf", "the filename, so a human recognises the review-queue row");
  assert.deepEqual(pdf.authors, [{ name: "Jane Roe" }]);
  // The MP3 is an enclosure too, and a podcast feed must not stage a thousand of them.
  assert.equal(arts.some((c) => c.url.endsWith(".mp3")), false);
});

test("rss: an Atom rel=enclosure is a file; a bare <link> stays the article's own permalink", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>A</title><link rel="alternate" href="https://site.com/essays/a"/>
      <link rel="enclosure" href="https://site.com/files/a.pdf"/>
      <published>2025-01-01T00:00:00Z</published></entry></feed>`;
  const arts = await rssAdapter.discover(ctx(fakeFetch({ "/feed": atom }), { includeExtensions: ["pdf"] }));
  assert.deepEqual(arts.map((c) => c.url), ["https://site.com/essays/a", "https://site.com/files/a.pdf"]);
  assert.equal(arts[1]!.publishedAt, "2025-01-01T00:00:00.000Z");
});
