/**
 * classify(): the human-vs-machine hinge, plus the per-publisher SEO allowlist.
 *
 * The asymmetry under test: search/discovery crawlers must read FREE (tolling them
 * deindexes the publisher), agents pay, humans never pay. The allowlist lets a
 * publisher free additional crawlers ahead of the known-bot signal — without ever
 * overriding an agent's own declared intent to pay.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, type RequestSignals } from "./agentDetect.ts";

function signals(over: Partial<RequestSignals> = {}): RequestSignals {
  return {
    userAgent: "",
    hasPaymentHeader: false,
    declaredAgentId: null,
    accept: "",
    headers: {},
    ...over,
  };
}

test("search indexers read free by default — bingbot is no longer tolled", () => {
  // Regression: bingbot used to sit in KNOWN_AGENT_UA and got a 402 → silent Bing
  // deindex. It must now classify human with no allowlist needed, like googlebot.
  for (const ua of ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
                     "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"]) {
    assert.equal(classify(signals({ userAgent: ua })).kind, "human", ua);
  }
});

test("a known bot with no allowlist is still an agent", () => {
  const v = classify(signals({ userAgent: "GPTBot/1.0" }));
  assert.equal(v.kind, "agent");
  assert.match(v.reason, /gptbot/);
});

test("seoAllowlist frees an otherwise-known crawler (case-insensitive)", () => {
  const v = classify(signals({ userAgent: "GPTBot/1.0" }), { seoAllowlist: ["GPTBot"] });
  assert.equal(v.kind, "human");
  assert.match(v.reason, /seo allowlist/);
});

test("declared payment intent still wins over the allowlist (an agent that wants to pay, pays)", () => {
  const v = classify(
    signals({ userAgent: "GPTBot/1.0", hasPaymentHeader: true }),
    { seoAllowlist: ["gptbot"] },
  );
  assert.equal(v.kind, "agent");
  assert.match(v.reason, /payment header/);
});

test("an empty/undefined allowlist changes nothing (single-tenant default path)", () => {
  assert.equal(classify(signals({ userAgent: "curl/8.0" })).kind, "agent");
  assert.equal(classify(signals({ userAgent: "curl/8.0" }), {}).kind, "agent");
});
