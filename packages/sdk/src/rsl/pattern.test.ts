import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPattern, specificity } from "./pattern.ts";

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
