import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPattern, matchesPublisherPattern, matchTarget, publisherPatterns, specificity } from "./pattern.ts";

test("a bare prefix matches everything under it (RFC 9309 prefix semantics)", () => {
  assert.equal(matchesPattern("/", "/anything/at/all"), true);
  assert.equal(matchesPattern("/articles", "/articles/2026/x"), true);
  assert.equal(matchesPattern("/articles", "/blog/x"), false);
});

test("`*` crosses path separators — the glob grammar would not, and would misprice", () => {
  // The failure this asserts: under crawl/glob.ts semantics `*` stops at `/`, so a priced
  // `/articles/*` would read as NOT covering a nested article and the agent would take it free.
  assert.equal(matchesPattern("/articles/*", "/articles/2026/03/deep-one"), true);
  assert.equal(matchesPattern("/*.pdf", "/papers/2026/q.pdf"), true);
});

test("a trailing `$` anchors the end of the path", () => {
  assert.equal(matchesPattern("/*.css$", "/assets/site.css"), true);
  assert.equal(matchesPattern("/*.css$", "/assets/site.css.map"), false);
  assert.equal(matchesPattern("/exact$", "/exact"), true);
  assert.equal(matchesPattern("/exact$", "/exact/more"), false);
});

test("a `$` that is not final is a literal", () => {
  assert.equal(matchesPattern("/a$b", "/a$b/c"), true);
  assert.equal(matchesPattern("/a$b", "/ab"), false);
});

test("regex metacharacters in a path are literals, not operators", () => {
  assert.equal(matchesPattern("/a.b", "/axb"), false);
  assert.equal(matchesPattern("/a.b", "/a.b"), true);
  assert.equal(matchesPattern("/q+r", "/q+r"), true);
});

test("an empty pattern matches nothing here — association scope is the caller's job", () => {
  assert.equal(matchesPattern("", "/anything"), false);
});

test("specificity: a longer literal wins, and wildcards buy nothing", () => {
  assert.ok(specificity("/articles/") > specificity("/"));
  assert.ok(specificity("/articles/2026/") > specificity("/articles/"));
  // `/*` is everything — it must not outrank a real path just for carrying two characters.
  assert.ok(specificity("/a") > specificity("/*"));
});

test("specificity: anchored beats the same prefix unanchored", () => {
  assert.ok(specificity("/a.pdf$") > specificity("/a.pdf"));
});

test("RFC 9309 matches path AND query: an anchored pattern does not cover a query", () => {
  assert.equal(matchesPattern("/a$", "/a"), true);
  assert.equal(matchesPattern("/a$", "/a?x"), false);
  assert.equal(matchesPattern("/a", "/a?x"), true); // a prefix still does
  assert.equal(matchesPattern("/*.pdf$", "/f.pdf?dl=1"), false);
  assert.equal(matchesPattern("/a?page=*", "/a?page=2"), true);
});

test("matchTarget is path plus query, never origin or fragment", () => {
  assert.equal(matchTarget("https://s.test/a/b?x=1#frag"), "/a/b?x=1");
  assert.equal(matchTarget("/a?x=1"), "/a?x=1");
  assert.equal(matchTarget(new URL("https://s.test/")), "/");
});

test("a publisher's /a$ means the article whatever its query", () => {
  assert.deepEqual(publisherPatterns("/a$"), ["/a$", "/a?*"]);
  assert.deepEqual(publisherPatterns("/*.pdf$"), ["/*.pdf$", "/*.pdf?*"]);
  assert.deepEqual(publisherPatterns("/a/*"), ["/a/*"]);
  // A pattern that already names a query is taken as written.
  assert.deepEqual(publisherPatterns("/a?page=1$"), ["/a?page=1$"]);
  assert.equal(matchesPublisherPattern("/a$", "/a?page=2"), true);
  assert.equal(matchesPublisherPattern("/a$", "/a"), true);
  assert.equal(matchesPublisherPattern("/a$", "/a/b"), false);
  assert.equal(matchesPublisherPattern("/a$", "/ab?x"), false);
  // Every expansion is itself a literal pattern a spec-following client matches the same way.
  for (const t of ["/a", "/a?page=2", "/a/b", "/ab"]) {
    assert.equal(publisherPatterns("/a$").some((p) => matchesPattern(p, t)), matchesPublisherPattern("/a$", t));
  }
});
