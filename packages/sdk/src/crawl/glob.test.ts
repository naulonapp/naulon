import { test } from "node:test";
import assert from "node:assert/strict";
import { passesGlobs } from "./glob.ts";

test("empty include lets everything through (subject to exclude)", () => {
  assert.equal(passesGlobs("/essays/x", [], []), true);
});

test("* matches within a segment, not across /", () => {
  assert.equal(passesGlobs("/essays/x", ["/essays/*"], []), true);
  assert.equal(passesGlobs("/essays/x/y", ["/essays/*"], []), false);
});

test("** matches across segments", () => {
  assert.equal(passesGlobs("/essays/x/y", ["/essays/**"], []), true);
});

test("? matches a single non-slash char", () => {
  assert.equal(passesGlobs("/a", ["/?"], []), true);
  assert.equal(passesGlobs("/ab", ["/?"], []), false);
});

test("exclude wins over include", () => {
  assert.equal(passesGlobs("/essays/drafts/x", ["/essays/**"], ["/essays/drafts/**"]), false);
});

test("a path matching no include is out", () => {
  assert.equal(passesGlobs("/about", ["/essays/**"], []), false);
});

test("glob literals are escaped (a dot is literal, not any-char)", () => {
  assert.equal(passesGlobs("/a.b", ["/a.b"], []), true);
  assert.equal(passesGlobs("/axb", ["/a.b"], []), false);
});
