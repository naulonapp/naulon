import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIncludeExtensions } from "./gate-scope.ts";

test("lowercases, strips the dot, trims, dedupes, sorts", () => {
  assert.deepEqual(normalizeIncludeExtensions([" .PDF ", "pdf", "JSON"]), ["json", "pdf"]);
});

test("refuses an extension the gate could never honour", () => {
  assert.throws(() => normalizeIncludeExtensions(["pdf", "ico"]), /favicon/i);
});

test("refuses a non-extension", () => {
  assert.throws(() => normalizeIncludeExtensions(["pdf/../etc"]), /alphanumeric/i);
  assert.throws(() => normalizeIncludeExtensions([".."]), /alphanumeric/i);
  assert.throws(() => normalizeIncludeExtensions([""]), /empty/i);
  assert.throws(() => normalizeIncludeExtensions(["."]), /empty/i);
  assert.throws(() => normalizeIncludeExtensions(["averyveryverylongextension"]), /too long/i);
});

test("refuses an absurd list", () => {
  assert.throws(() => normalizeIncludeExtensions(Array.from({ length: 21 }, (_, i) => `e${i}`)), /exceeds/i);
});

test("an empty list is legal and means 'toll nothing extra'", () => {
  assert.deepEqual(normalizeIncludeExtensions([]), []);
});

test("a control character can never reach a stored extension", () => {
  assert.throws(() => normalizeIncludeExtensions(["pd\nf"]), /alphanumeric/i);
});
