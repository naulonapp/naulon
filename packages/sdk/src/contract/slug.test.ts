import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSlug, deriveSiteSlug, deriveSlug, slugFromPath, slugFromSitePath } from "./slug.ts";

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
