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
import { CRAWLER_REGISTRY } from "@naulon/shared";
import { classify, KNOWN_AGENT_UA, type RequestSignals } from "./agentDetect.ts";

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

/* ── Operator-doc parity (2026-08-03) ──────────────────────────────────────────
 * Two mirrors of one vocabulary, neither previously enforced: the shared crawler
 * registry's `defaultCharged` claims to mirror this list, and the real UA strings
 * operators ship are browser-prefixed, so a token that is merely PRESENT is not
 * proof the classifier reaches it. */

test("the user-triggered fetchers are charged, in the exact UA their operator publishes", () => {
  // The 2026-08-03 additions, verbatim from each operator's own doc page (Meta's
  // web-crawlers page, developer.amazon.com/amazonbot, and the docs.mistral.ai/robots
  // endpoint MistralAI-User cites). Not paraphrased: a UA these fail on is a toll that
  // silently does not happen.
  const cases: Array<[string, string]> = [
    ["meta-externalfetcher", "meta-externalfetcher/1.1 (+/documentation/sharing/webmasters/web-crawlers)"],
    ["meta-externalfetcher", "meta-externalfetcher/1.1"],
    ["amzn-user", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-User/0.1) Chrome/W.X.Y.Z Safari/537.36"],
    ["mistralai-user", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)"],
  ];
  for (const [fragment, ua] of cases) {
    // Accept: text/html because two of these wear a full browser UA — step 3 (known-bot)
    // must keep running before step 4 (browser-shaped), or a browser-prefixed crawler
    // reads free forever. That ordering is the whole reason these are reachable.
    const v = classify(signals({ userAgent: ua, accept: "text/html" }));
    assert.equal(v.kind, "agent", ua);
    assert.match(v.reason, new RegExp(fragment));
  }
});

test("their operators' SEARCH siblings still read free", () => {
  // Meta and Amazon each ship a search indexer alongside the fetcher above. Tolling
  // one deindexes the publisher, so they must stay human — and they are the reason
  // adding the fetchers cannot be done by matching "meta-" or "amzn-".
  for (const ua of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/W.X.Y.Z Safari/537.36",
  ]) {
    assert.equal(classify(signals({ userAgent: ua, accept: "text/html" })).kind, "human", ua);
  }
});

test("ExaSearchBot is charged in the exact UA Exa publishes", () => {
  // Verbatim from crawler.exa.ai on 2026-09-02, the operator's own page. Browser-prefixed
  // like Amzn-User, so it is only reachable because step 3 (known-bot) runs before step 4
  // (browser-shaped). Note what it does NOT contain: "crawler" is not "curl", and a fragment
  // list matched by substring is exactly where that kind of near-miss decides a toll.
  const ua = "Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)";
  const v = classify(signals({ userAgent: ua, accept: "text/html" }));
  assert.equal(v.kind, "agent", ua);
  assert.match(v.reason, /exasearchbot/);
});

test("every registry row's defaultCharged matches this list — the mirror is enforced now", () => {
  // CRAWLER_REGISTRY.defaultCharged has always been a hand-kept copy of KNOWN_AGENT_UA
  // ("keep in sync when the gate list changes"), with nothing to notice when it wasn't.
  // A wrong flag here is a lying UI: the Crawlers tab tells a publisher a crawler is
  // already charged (or isn't) and the gate does the opposite.
  for (const c of CRAWLER_REGISTRY) {
    const charged = KNOWN_AGENT_UA.some((frag) => c.fragment.includes(frag));
    assert.equal(
      c.defaultCharged,
      charged,
      `${c.name} (${c.fragment}): registry says defaultCharged=${c.defaultCharged}, the gate list says ${charged}`,
    );
  }
});

test("no registry fragment is a substring of another that would shadow it", () => {
  // applebot-extended/applebot and meta-externalagent/meta-externalfetcher are one
  // typo apart from a bucket that silently swallows its sibling. Where one fragment
  // does contain another, the specific one must sort first for a longest-first match
  // to be able to reach it — the audit plane's agentKey depends on exactly that.
  for (const a of CRAWLER_REGISTRY) {
    for (const b of CRAWLER_REGISTRY) {
      if (a.id === b.id || !a.fragment.includes(b.fragment)) continue;
      assert.ok(
        a.fragment.length > b.fragment.length,
        `${a.fragment} contains ${b.fragment} but is not longer — one of them is unreachable`,
      );
    }
  }
});
