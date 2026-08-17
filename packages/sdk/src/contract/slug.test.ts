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
