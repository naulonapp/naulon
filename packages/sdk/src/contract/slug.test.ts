import { test } from "node:test";
import assert from "node:assert/strict";
import { STATIC_EXTENSIONS, decodeSlug, deriveSiteSlug, deriveSlug, slugFromPath, slugFromSitePath } from "./slug.ts";

test("deriveSlug pulls the segment after a configured prefix", () => {
  assert.equal(deriveSlug("https://site.com/essays/on-stillness", ["essays"]), "on-stillness");
});

test("deriveSlug matches the FIRST segment only (mirrors the gate)", () => {
  assert.equal(deriveSlug("https://site.com/essays/on-stillness/part-2", ["essays"]), "on-stillness");
});

test("deriveSlug tries every prefix", () => {
  assert.equal(deriveSlug("https://site.com/articles/x", ["essays", "articles", "posts"]), "x");
});

test("deriveSlug returns null when no prefix matches", () => {
  assert.equal(deriveSlug("https://site.com/about", ["essays"]), null);
});

test("deriveSlug returns null for the gate's own control routes", () => {
  assert.equal(deriveSlug("https://site.com/.well-known/x402", ["essays", ".well-known"]), null);
  assert.equal(deriveSlug("https://site.com/licenses/abc", ["licenses"]), null);
});

test("deriveSlug returns null with no prefixes", () => {
  assert.equal(deriveSlug("https://site.com/essays/x", []), null);
});

test("deriveSlug decodes percent-encoding", () => {
  assert.equal(deriveSlug("https://site.com/essays/caf%C3%A9", ["essays"]), "café");
});

test("deriveSlug strips query and hash", () => {
  assert.equal(deriveSlug("https://site.com/essays/x?utm=1#top", ["essays"]), "x");
});

test("deriveSlug returns null on a malformed URL", () => {
  assert.equal(deriveSlug("not a url", ["essays"]), null);
});

test("deriveSlug escapes regex-special prefix chars (no injection)", () => {
  // A prefix with a regex metachar must match literally, not as a pattern.
  assert.equal(deriveSlug("https://site.com/a.b/x", ["a.b"]), "x");
  assert.equal(deriveSlug("https://site.com/axb/x", ["a.b"]), null);
});

/* ── the malformed-escape regression (2026-08-17) ────────────────────────────────
 * `decodeURIComponent("100%")` throws `URIError: URI malformed`, and a raw
 * `GET /essays/100%` reaches a handler with that path verbatim — node does not
 * reject or normalize it. Four of the five copies of this rule called the bare
 * decode, so the gate answered 500 to a request that should have passed through
 * free, and one such URL in a sitemap aborted a whole tenant's crawl. Every entry
 * point must now answer `null` — "not an article" — and never throw.
 */

test("decodeSlug answers null instead of throwing on a bad escape", () => {
  assert.equal(decodeSlug("caf%C3%A9"), "café");
  assert.equal(decodeSlug("100%"), null);
  assert.equal(decodeSlug("%zz"), null);
  assert.equal(decodeSlug("%"), null);
});

test("no slug entry point throws on a malformed percent-escape", () => {
  const calls: Array<[string, () => string | null]> = [
    ["slugFromPath", () => slugFromPath("/essays/100%", ["essays"])],
    ["slugFromSitePath", () => slugFromSitePath("/blog/100%", [])],
    ["deriveSlug", () => deriveSlug("https://site.com/essays/100%", ["essays"])],
    ["deriveSiteSlug", () => deriveSiteSlug("https://site.com/blog/100%", [])],
  ];
  for (const [name, fn] of calls) {
    assert.doesNotThrow(fn, `${name} must not throw on a malformed escape`);
    assert.equal(fn(), null, `${name} must answer "not an article"`);
  }
});

test("slugFromPath and deriveSlug agree on the same path (the join that must hold)", () => {
  const prefixes = ["essays", "notes"];
  for (const path of ["/essays/on-stillness", "/notes/caf%C3%A9", "/essays/x?utm=1", "/about", "/essays/100%"]) {
    assert.equal(
      slugFromPath(path, prefixes),
      deriveSlug(`https://site.com${path}`, prefixes),
      `path-side and url-side must key ${path} identically`,
    );
  }
});

test("site-mode: control routes, discovery and static assets never toll", () => {
  assert.equal(slugFromSitePath("/2026/08/a-post", []), "/2026/08/a-post");
  assert.equal(slugFromSitePath("/robots.txt", []), null);
  assert.equal(slugFromSitePath("/sitemap-index.xml", []), null);
  assert.equal(slugFromSitePath("/app.css", []), null);
  assert.equal(slugFromSitePath("/.well-known/x402", []), null);
  assert.equal(slugFromSitePath("/licenses/abc", []), null);
  assert.equal(slugFromSitePath("/private/x", ["private"]), null);
  assert.equal(slugFromSitePath("/private", ["private"]), null);
});

// ── site-mode extension allowlist (gateScope.includeExtensions) ────────────────
// The publisher opts a file type INTO the toll. Everything below the allowlist —
// discovery surfaces, control routes, the publisher's own excludePrefixes — is
// refused BEFORE it is consulted, so opting into `xml` can never toll a sitemap.

test("site-mode: an allowlisted extension becomes gateable", () => {
  assert.equal(slugFromSitePath("/papers/quantum.pdf", [], { includeExtensions: ["pdf"] }), "/papers/quantum.pdf");
  assert.equal(
    slugFromSitePath("/papers/2026/quantum.pdf", [], { includeExtensions: ["pdf"] }),
    "/papers/2026/quantum.pdf",
  );
});

test("site-mode: a NON-allowlisted extension stays free", () => {
  assert.equal(slugFromSitePath("/app.css", [], { includeExtensions: ["pdf"] }), null);
  assert.equal(slugFromSitePath("/logo.png", [], { includeExtensions: ["pdf"] }), null);
  assert.equal(slugFromSitePath("/bundle.js", [], { includeExtensions: ["pdf"] }), null);
});

test("site-mode: discovery ALWAYS wins over the allowlist", () => {
  const opts = { includeExtensions: ["xml", "txt", "json"] };
  for (const p of ["/robots.txt", "/sitemap.xml", "/sitemap-index.xml", "/rss.xml", "/atom.xml", "/feed.xml", "/favicon.ico"]) {
    assert.equal(slugFromSitePath(p, [], opts), null, `${p} must stay free`);
  }
});

test("site-mode: control routes ALWAYS win over the allowlist", () => {
  const opts = { includeExtensions: ["json"] };
  assert.equal(slugFromSitePath("/.well-known/x402", [], opts), null);
  assert.equal(slugFromSitePath("/.well-known/naulon-jwks.json", [], opts), null);
  assert.equal(slugFromSitePath("/licenses/abc.json", [], opts), null);
});

test("site-mode: excludePrefixes still win over the allowlist", () => {
  assert.equal(slugFromSitePath("/free/paper.pdf", ["free"], { includeExtensions: ["pdf"] }), null);
});

test("site-mode: absent opts is byte-identical to today (regression)", () => {
  assert.equal(slugFromSitePath("/papers/quantum.pdf", []), null);
  assert.equal(slugFromSitePath("/2026/08/a-post", []), "/2026/08/a-post");
  assert.equal(slugFromSitePath("/app.css", []), null);
});

test("site-mode: an empty allowlist is the same as absent", () => {
  assert.equal(slugFromSitePath("/papers/quantum.pdf", [], { includeExtensions: [] }), null);
});

test("site-mode: the allowlist is case-insensitive on the PATH (.PDF is a pdf)", () => {
  assert.equal(slugFromSitePath("/papers/Q.PDF", [], { includeExtensions: ["pdf"] }), "/papers/Q.PDF");
});

test("deriveSiteSlug carries the allowlist (the crawler/gate join)", () => {
  const opts = { includeExtensions: ["pdf"] };
  assert.equal(deriveSiteSlug("https://s.test/papers/q.pdf", [], opts), slugFromSitePath("/papers/q.pdf", [], opts));
  assert.equal(deriveSiteSlug("https://s.test/papers/q.pdf", [], opts), "/papers/q.pdf");
});

test("site-mode: a malformed escape stays free even when allowlisted", () => {
  assert.equal(slugFromSitePath("/papers/100%.pdf", [], { includeExtensions: ["pdf"] }), null);
});

test("site-mode: a dotless path is unaffected by the allowlist", () => {
  assert.equal(slugFromSitePath("/papers/quantum", [], { includeExtensions: ["pdf"] }), "/papers/quantum");
});

// ── discovery is matched by FILENAME, at any depth ────────────────────────────
// The root-anchored matcher was never enough, and opting an extension in is what
// made that expensive: with `xml` ticked, /sitemap.xml was free while WordPress's
// own /wp-sitemap.xml tolled. Paywalling a sitemap starves the catalog agents buy
// from — the one thing site mode exists to refuse.

test("site-mode: real-world sitemaps stay free even with xml opted in", () => {
  const opts = { includeExtensions: ["xml", "txt", "json"] };
  for (const p of [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/wp-sitemap.xml",
    "/wp-sitemap-posts-post-1.xml",
    "/post-sitemap.xml",
    "/page-sitemap.xml",
    "/sitemap-1.xml.gz",
    "/en/sitemap.xml",
    "/blog/sitemap.xml",
  ]) {
    assert.equal(slugFromSitePath(p, [], opts), null, `${p} must stay free`);
  }
});

test("site-mode: feeds stay free at any depth, and with a trailing slash", () => {
  const opts = { includeExtensions: ["xml", "json"] };
  for (const p of ["/index.xml", "/blog/feed.xml", "/news/rss.xml", "/blog/atom.xml", "/feed/", "/feeds/", "/blog/feed/"]) {
    assert.equal(slugFromSitePath(p, [], opts), null, `${p} must stay free`);
  }
});

test("site-mode: the agent-discovery text files stay free with txt opted in", () => {
  const opts = { includeExtensions: ["txt"] };
  for (const p of ["/llms.txt", "/ads.txt", "/app-ads.txt", "/security.txt", "/.well-known/security.txt", "/robots.txt"]) {
    assert.equal(slugFromSitePath(p, [], opts), null, `${p} must stay free`);
  }
});

test("site-mode: a 'feed'-PREFIXED article still tolls — the rule is the whole segment", () => {
  const opts = { includeExtensions: ["pdf"] };
  assert.equal(slugFromSitePath("/papers/feedback-loops.pdf", [], opts), "/papers/feedback-loops.pdf");
  assert.equal(slugFromSitePath("/essays/atomic-habits", [], opts), "/essays/atomic-habits");
  assert.equal(slugFromSitePath("/blog/rss-explained.pdf", [], opts), "/blog/rss-explained.pdf");
});

test("site-mode: the LEGACY root matcher still over-refuses, deliberately", () => {
  // `DISCOVERY_ROOT_RE` matches `/rss*`, `/feed*`, `/atom*`, `/sitemap*` at the root, so a
  // root-level `/rssistan-report.pdf` has always been free. The name-shaped rules are a UNION
  // with it rather than a replacement: narrowing it would make paths that were free start
  // charging, which is the one direction this codebase does not change silently. Nested paths
  // are unaffected (the case above), which is where real articles live.
  assert.equal(slugFromSitePath("/rssistan-report.pdf", [], { includeExtensions: ["pdf"] }), null);
});

test("site-mode: a doubled leading slash cannot smuggle a control route into the toll", () => {
  const opts = { includeExtensions: ["json"] };
  assert.equal(slugFromSitePath("//.well-known/naulon-jwks.json", [], opts), null);
  assert.equal(slugFromSitePath("///licenses/abc.json", [], opts), null);
});

test("site-mode: a non-array includeExtensions fails toward FREE, never a substring match or a throw", () => {
  // gate_scope is untyped jsonb: a string would make `.includes` a substring matcher
  // ("json" tolls every .js), an object or number would throw out of decide() and 503
  // the whole tenant — humans included.
  for (const bad of ["json", {}, 5, true, null, undefined]) {
    assert.equal(slugFromSitePath("/x.js", [], { includeExtensions: bad as never }), null);
    assert.equal(slugFromSitePath("/x.json", [], { includeExtensions: bad as never }), null);
  }
});

// ── STATIC_EXTENSIONS is the matcher's own source, not a copy of it ──────────────────────────
// The list has three readers — this matcher, the crawler's media pass, and a publisher's RSL
// document — and the two outside this file used to re-derive it. A copy that drifts makes the
// crawl stage a row for a path the gate serves free, or a licence price a file nobody is charged
// for. So the regex is BUILT from the constant, and this proves the two cannot disagree.

test("every listed extension is free by default, and opting it in tolls it", () => {
  for (const ext of STATIC_EXTENSIONS) {
    const path = `/papers/file.${ext}`;
    assert.equal(slugFromSitePath(path, [], {}), null, `.${ext} must be free by default`);
    if (ext === "ico") continue; // refused as a discovery surface before the allowlist is read
    assert.equal(slugFromSitePath(path, [], { includeExtensions: [ext] }), path, `.${ext} must be opt-in-able`);
  }
});

test("an extension NOT on the list was never free, so opting it in changes nothing", () => {
  // The list is the free set, not the tollable set: `.docx` has always tolled in site mode.
  assert.equal(STATIC_EXTENSIONS.includes("docx"), false);
  assert.equal(slugFromSitePath("/papers/minutes.docx", [], {}), "/papers/minutes.docx");
});

test("the list is sorted and unique — it is read by humans and diffed by reviewers", () => {
  assert.deepEqual([...STATIC_EXTENSIONS], [...new Set(STATIC_EXTENSIONS)].sort());
});
