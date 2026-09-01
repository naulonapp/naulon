import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionOf, isOptedInFile, mediaExtensions } from "./media.ts";

test("extensionOf reads the PATH only — query, fragment and directory dots do not count", () => {
  assert.equal(extensionOf("https://site.com/papers/q.pdf"), "pdf");
  assert.equal(extensionOf("https://site.com/papers/q.PDF"), "pdf");
  assert.equal(extensionOf("https://site.com/papers/q.pdf?v=2#page=3"), "pdf");
  assert.equal(extensionOf("https://site.com/v1.2/notes"), "", "a dot in a directory is not an extension");
  assert.equal(extensionOf("https://site.com/essays/on-stillness"), "");
  assert.equal(extensionOf("https://site.com/"), "");
  assert.equal(extensionOf("/relative/report.xml"), "xml", "a relative url still parses");
  assert.equal(extensionOf(".hidden"), "", "a leading dot is not an extension");
});

test("mediaExtensions normalises the way the write path stores them", () => {
  const set = mediaExtensions({ includeExtensions: [" .PDF ", "pdf", "JSON", ""] });
  assert.deepEqual([...set].sort(), ["json", "pdf"]);
});

test("mediaExtensions applies no policy of its own — the write path and the gate own that", () => {
  // A second "never discover" list here would be a second owner for a question
  // `normalizeIncludeExtensions` (which refuses `ico`) and `slugFromSitePath` already answer. Two
  // owners is how a crawl ends up refusing to stage a file the gate is charging for.
  const set = mediaExtensions({ includeExtensions: ["png", "pdf"] });
  assert.deepEqual([...set].sort(), ["pdf", "png"]);
});

test("an absent or empty list discovers nothing — the historical behaviour, exactly", () => {
  assert.equal(mediaExtensions({}).size, 0);
  assert.equal(mediaExtensions({ includeExtensions: [] }).size, 0);
  assert.equal(isOptedInFile("https://site.com/q.pdf", mediaExtensions({})), false);
});

test("isOptedInFile is false for every HTML page, so a media pass can only ever ADD rows", () => {
  const set = mediaExtensions({ includeExtensions: ["pdf"] });
  assert.equal(isOptedInFile("https://site.com/papers/q.pdf", set), true);
  assert.equal(isOptedInFile("https://site.com/essays/on-stillness", set), false);
  assert.equal(isOptedInFile("https://site.com/papers/q.docx", set), false);
});
