import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSlug } from "./slug.ts";

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
