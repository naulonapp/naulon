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

test("mediaExtensions refuses the extensions the gate keeps free, whatever a config claims", () => {
  // A human reader must never meet a payment wall because a font 402'd, so discovering these
  // could only ever stage rows that cannot toll. `slugFromSitePath` refuses them one layer down.
  const set = mediaExtensions({ includeExtensions: ["png", "css", "js", "woff2", "ico", "svg", "pdf"] });
  assert.deepEqual([...set], ["pdf"]);
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
