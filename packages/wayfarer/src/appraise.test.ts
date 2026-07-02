/**
 * Appraisal's offline (no OPENAI_API_KEY) path: keyword-overlap relevance. The
 * LLM path needs creds + network and is out of scope for the unit suite.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfig, usdc } from "@naulon/shared";
import { appraise } from "./appraise.ts";
import type { PricedCandidate } from "./types.ts";

function priced(slug: string, title: string, summary: string): PricedCandidate {
  return { slug, title, summary, price: usdc(0.001) };
}

test("scores relevance as matched topic terms / topic terms", async () => {
  const had = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetConfig();
  try {
    const [c] = await appraise("payment and passage", [
      priced("the-naulon", "The Naulon", "the fare paid to cross: payment, passage, debt"),
    ]);
    // topic terms after stopword strip: {payment, passage} — both present.
    assert.equal(c?.relevance, 1);
    assert.match(c?.rationale ?? "", /payment/);
  } finally {
    if (had !== undefined) process.env.OPENAI_API_KEY = had;
    resetConfig();
  }
});

test("partial overlap scores the fraction of topic terms hit", async () => {
  const had = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetConfig();
  try {
    const [c] = await appraise("payment and silence", [
      priced("the-naulon", "The Naulon", "the fare paid to cross: payment, debt"),
    ]);
    // {payment, silence} — only "payment" hits → 0.5.
    assert.equal(c?.relevance, 0.5);
  } finally {
    if (had !== undefined) process.env.OPENAI_API_KEY = had;
    resetConfig();
  }
});

test("no overlap scores zero with an explaining rationale", async () => {
  const had = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetConfig();
  try {
    const [c] = await appraise("quantum chromodynamics", [
      priced("on-stillness", "On Stillness", "attention, silence, staying with one thing"),
    ]);
    assert.equal(c?.relevance, 0);
    assert.match(c?.rationale ?? "", /no topic-term overlap/);
  } finally {
    if (had !== undefined) process.env.OPENAI_API_KEY = had;
    resetConfig();
  }
});

test("preserves price and the rest of the candidate through appraisal", async () => {
  const had = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetConfig();
  try {
    const [c] = await appraise("stillness", [priced("on-stillness", "On Stillness", "stillness")]);
    assert.equal(c?.price, usdc(0.001));
    assert.equal(c?.slug, "on-stillness");
  } finally {
    if (had !== undefined) process.env.OPENAI_API_KEY = had;
    resetConfig();
  }
});
