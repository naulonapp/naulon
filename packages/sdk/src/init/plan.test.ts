import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitPlan,
  initAnswersSchema,
  INIT_DEFAULTS,
  PLACEHOLDER_WALLET,
  type InitAnswers,
} from "./plan.ts";
import { parseCredits } from "../contract/credits.ts";

const WALLET = "0x1111111111111111111111111111111111111111";

function answers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    originUrl: "https://mysite.com",
    priceUsdc: 0.002,
    citationMultiplier: 5,
    paymentMode: "mock",
    settlementNetwork: "arcTestnet",
    tollgatePort: 8402,
    articlePrefixes: "essays,articles",
    creditsPath: "./credits.json",
    starterSlug: "welcome",
    starterTitle: "Welcome",
    starterAuthorId: "you",
    defaultWallet: WALLET,
    ...overrides,
  };
}

test("env carries the collected core toll values", () => {
  const { env } = buildInitPlan(answers());
  assert.match(env.contents, /^PAYMENT_MODE=mock$/m);
  assert.match(env.contents, /^ORIGIN_URL=https:\/\/mysite\.com$/m);
  assert.match(env.contents, /^DEFAULT_PRICE_USDC=0\.002$/m);
  assert.match(env.contents, /^CITATION_MULTIPLIER=5$/m);
  assert.match(env.contents, /^ARTICLE_PATH_PREFIXES=essays,articles$/m);
  assert.match(env.contents, /^CREDITS_FIXTURES=\.\/credits\.json$/m);
  assert.equal(env.path, ".env");
});

test("mock mode explains itself and does NOT emit gateway keys", () => {
  const { env, warnings } = buildInitPlan(answers({ paymentMode: "mock" }));
  assert.doesNotMatch(env.contents, /SETTLEMENT_NETWORK/);
  assert.doesNotMatch(env.contents, /RELAYER_PRIVATE_KEY/);
  assert.ok(warnings.some((w) => /mock/i.test(w)));
});

test("gateway mode emits the network + the creds-to-fill guidance + warns", () => {
  const { env, warnings } = buildInitPlan(answers({ paymentMode: "gateway", settlementNetwork: "base" }));
  assert.match(env.contents, /^SETTLEMENT_NETWORK=base$/m);
  assert.match(env.contents, /RELAYER_PRIVATE_KEY/);
  assert.match(env.contents, /CIRCLE_API_KEY/);
  assert.ok(warnings.some((w) => /gateway/i.test(w) && /RELAYER_PRIVATE_KEY/.test(w)));
});

test("credits.json is a valid contract file keyed by slug, using the real wallet", () => {
  const { credits } = buildInitPlan(answers({ starterSlug: "on-stillness", starterTitle: "On Stillness" }));
  assert.equal(credits.path, "./credits.json");
  const map = JSON.parse(credits.contents);
  assert.deepEqual(Object.keys(map), ["on-stillness"]);
  // Each entry must satisfy the same contract the gate enforces at boot.
  const article = parseCredits(map["on-stillness"], "test");
  assert.equal(article.contributors[0]?.wallet, WALLET);
});

test("wallet-less answers still produce a valid (placeholder) file + a loud warning", () => {
  const { credits, warnings } = buildInitPlan(answers({ defaultWallet: undefined }));
  const map = JSON.parse(credits.contents);
  const article = parseCredits(map["welcome"], "test"); // still valid → gate boots
  assert.equal(article.contributors[0]?.wallet, PLACEHOLDER_WALLET);
  assert.ok(warnings.some((w) => /placeholder/i.test(w)));
});

test("next steps reference the real port + first prefix + starter slug", () => {
  const { nextSteps } = buildInitPlan(answers({ tollgatePort: 9000, articlePrefixes: "posts,essays", starterSlug: "hello" }));
  assert.ok(nextSteps.some((s) => /localhost:9000\/posts\/hello/.test(s)));
});

test("next steps point at `naulon crawl` — the drafting slice picks up where init leaves off", () => {
  const { nextSteps } = buildInitPlan(answers({}));
  assert.ok(nextSteps.some((s) => /naulon crawl/.test(s)));
});

test("schema rejects a bad origin, a non-positive price, and a malformed wallet", () => {
  assert.throws(() => initAnswersSchema.parse(answers({ originUrl: "not-a-url" })));
  assert.throws(() => initAnswersSchema.parse(answers({ priceUsdc: 0 })));
  assert.throws(() => initAnswersSchema.parse(answers({ defaultWallet: "0xnothex" as never })));
});

test("INIT_DEFAULTS are themselves valid answers (defaults must never be un-plannable)", () => {
  const fromDefaults = buildInitPlan({
    ...INIT_DEFAULTS,
    settlementNetwork: "arcTestnet",
    defaultWallet: undefined,
  } as InitAnswers);
  assert.match(fromDefaults.env.contents, /^PAYMENT_MODE=mock$/m);
});
