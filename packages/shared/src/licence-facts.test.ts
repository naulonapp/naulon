/**
 * The grant sentence is what a model obeys, so it must agree with the terms it was built from.
 *
 * `usageSentence` is derived rather than written beside the claim precisely so the two cannot
 * disagree. These assert the derivation in both directions: every term it grants appears, and
 * every term it withholds is refused in the same sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageSentence } from "./licence-facts.ts";

test("absent terms are the default grounding right, not an absence of rights", () => {
  const s = usageSentence(undefined);
  assert.match(s, /read it, quote it, summarise it/);
  assert.match(s, /NOT republish it publicly or use it as training data/);
});

test("each sold term adds its own clause", () => {
  assert.match(usageSentence(["search"]), /surface it in search results/);
  assert.match(usageSentence(["ai-index"]), /index it for retrieval/);
});

test("a licence that grants training says so, and stops refusing it", () => {
  const s = usageSentence(["ai-input", "ai-train"]);
  assert.match(s, /use it as training data/);
  assert.doesNotMatch(
    s,
    /NOT republish it publicly or use it as training data/,
    "granting a term and refusing it in the same sentence is worse than saying neither",
  );
  assert.match(s, /NOT republish it publicly\./);
});

test("republication is refused whatever was bought", () => {
  for (const terms of [undefined, ["ai-input"], ["ai-input", "ai-index", "search", "ai-train"]]) {
    assert.match(usageSentence(terms), /NOT republish it publicly/);
  }
});
