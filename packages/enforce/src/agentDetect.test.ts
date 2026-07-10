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

test("user-triggered assistant fetches are agents — the citation moment is charged", () => {
  // Live-verified UA tokens (operator docs, 2026-07-03): these are machine-only
  // UAs; no human browser carries them, so charging cannot toll a human.
  for (const ua of [
    "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
    "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  ]) {
    assert.equal(classify(signals({ userAgent: ua })).kind, "agent", ua);
  }
});

test("AI search indexers read free like classic search — tolling them deindexes", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)",
    "Mozilla/5.0 AppleWebKit/537.36; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot",
  ]) {
    assert.equal(classify(signals({ userAgent: ua, accept: "text/html" })).kind, "human", ua);
  }
});

test("dropped stale fragments no longer classify — claude-web / anthropic-ai are undocumented", () => {
  // These tokens left Anthropic's published UA list; keeping them would be a
  // registry that lies. A browser-shaped request carrying one reads free.
  for (const ua of ["claude-web/1.0", "anthropic-ai/1.0"]) {
    assert.equal(classify(signals({ userAgent: ua, accept: "text/html" })).kind, "human", ua);
  }
});

/* ------------------------------------------------------------------ *
 * Web Bot Auth verified identity in classify() — precedence:
 * payment intent → verified allow → verified agent → (unsigned) UA path.
 * ------------------------------------------------------------------ */

const VERIFIED = { agent: "chatgpt.com", keyid: "thumb" };

test("verified agent is charged even with a browser-shaped request (dodge hole closed)", () => {
  const v = classify(
    signals({
      userAgent: "Mozilla/5.0 Firefox/128.0",
      accept: "text/html",
      verifiedAgent: VERIFIED,
    }),
  );
  assert.equal(v.kind, "agent");
  assert.match(v.reason, /verified web-bot-auth \(chatgpt\.com\)/);
  assert.ok(v.confidence >= 0.98);
});

test("verified agent matching the allowlist reads free — the spoof-proof allow", () => {
  const v = classify(signals({ verifiedAgent: VERIFIED }), { seoAllowlist: ["chatgpt.com"] });
  assert.equal(v.kind, "human");
  assert.match(v.reason, /verified/);
});

test("UA-allowlist fragment does NOT free a verified agent whose identity mismatches (free-ride hole closed)", () => {
  // UA claims googlebot (allow-listed); the cryptographic identity is not.
  const v = classify(
    signals({ userAgent: "Googlebot/2.1", verifiedAgent: VERIFIED }),
    { seoAllowlist: ["googlebot"] },
  );
  assert.equal(v.kind, "agent", "verified identity outranks the spoofable UA allowlist");
});

test("payment intent still wins over verified identity", () => {
  const v = classify(signals({ hasPaymentHeader: true, verifiedAgent: VERIFIED }));
  assert.equal(v.kind, "agent");
  assert.match(v.reason, /payment header/);
});

test("absent verifiedAgent: verdicts are byte-identical to the pre-WBA classifier (regression)", () => {
  const cases: Array<[Partial<RequestSignals>, Parameters<typeof classify>[1]]> = [
    [{ userAgent: "GPTBot/1.0" }, undefined],
    [{ userAgent: "Mozilla/5.0", accept: "text/html" }, undefined],
    [{ userAgent: "Googlebot/2.1" }, { seoAllowlist: ["googlebot"] }],
    [{ userAgent: "StealthBot/1.0" }, { chargeList: ["stealthbot"] }],
    [{ userAgent: "" }, undefined],
  ];
  for (const [over, policy] of cases) {
    const without = classify(signals(over), policy);
    const withNull = classify(signals({ ...over, verifiedAgent: null }), policy);
    assert.deepEqual(withNull, without);
  }
});
