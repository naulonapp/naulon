import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeNetwork,
  usdc,
  walletAddress,
  type ArticleCredits,
  type CreditsResolver,
  type PublisherConfig,
} from "@naulon/shared";
import { quote, tollPrice } from "./pricing.ts";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const CREDITS: ArticleCredits = {
  slug: "on-passage",
  title: "On Passage",
  contributors: [{ authorId: "anna", wallet: walletAddress(WALLET) }],
};

/** Credits source that knows exactly one article. */
const oneArticle: CreditsResolver = {
  async resolve(slug) {
    return slug === CREDITS.slug ? CREDITS : undefined;
  },
};

function publisher(overrides: Partial<PublisherConfig> = {}): PublisherConfig {
  return {
    id: "test",
    originUrl: "http://origin.local",
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: oneArticle,
    licenseIdentity: "naulon:test",
    ...overrides,
  };
}

test("quote prices a read at the base price", async () => {
  const q = await quote(publisher(), "on-passage", "read");
  assert.ok(q);
  assert.equal(q.price, 0.001);
  assert.equal(q.kind, "read");
  assert.equal(q.payees.length, 1);
  assert.equal(q.payees[0]!.wallet, WALLET);
});

test("quote prices a citation at price * citationMultiplier", async () => {
  const q = await quote(publisher(), "on-passage", "citation");
  assert.ok(q);
  assert.equal(q.price, 0.005); // 0.001 * 5
});

test("tollPrice is the same number quote() charges, for both kinds", async () => {
  // The point of exporting it: a verifier that never calls quote() must land on the
  // identical figure. Asserted against quote's own output rather than a literal, so a
  // future formula change cannot pass here while breaking the quoting path.
  for (const kind of ["read", "citation"] as const) {
    const q = await quote(publisher(), "on-passage", kind);
    assert.ok(q);
    assert.equal(tollPrice(publisher(), kind), q.price);
  }
});

test("tollPrice reads only price and citationMultiplier", () => {
  // No credits source, no id, no wallet — the structural subset a control plane holds
  // when it has a tenant record but has not resolved an article.
  assert.equal(tollPrice({ price: usdc(0.002), citationMultiplier: 3 }, "citation"), 0.006);
  assert.equal(tollPrice({ price: usdc(0.002), citationMultiplier: 3 }, "read"), 0.002);
});

test("citationMultiplier is configurable per publisher", async () => {
  const q = await quote(publisher({ citationMultiplier: 1 }), "on-passage", "citation");
  assert.ok(q);
  assert.equal(q.price, 0.001); // a citation priced the same as a read
});

test("quote returns undefined for an article the publisher doesn't know", async () => {
  const q = await quote(publisher(), "unknown-slug", "read");
  assert.equal(q, undefined);
});

test("a publisher with no extraLegs hook yields zero legs (back-compat default)", async () => {
  const q = await quote(publisher(), "on-passage", "read");
  assert.ok(q);
  assert.deepEqual(q.extraLegs, []);
});

test("extraLegs hook is honored and is additive — author price/payees unchanged", async () => {
  const OPERATOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  // A 10%-of-price fee leg — the *amount math* is the resolver's business; pricing
  // just carries what the hook returns.
  const withFee = publisher({
    extraLegs: (price) => [
      { role: "operator", payTo: walletAddress(OPERATOR), amount: String(Math.round((price as number) * 1e6 * 0.1)) },
    ],
  });
  const q = await quote(withFee, "on-passage", "read");
  assert.ok(q);
  // Author leg is untouched by the fee — provably not a skim.
  assert.equal(q.price, 0.001);
  assert.equal(q.payees.length, 1);
  assert.equal(q.payees[0]!.wallet, WALLET);
  // The operator leg rides alongside, additive.
  assert.equal(q.extraLegs.length, 1);
  assert.equal(q.extraLegs[0]!.role, "operator");
  assert.equal(q.extraLegs[0]!.payTo, OPERATOR);
  assert.equal(q.extraLegs[0]!.amount, "100"); // 0.001 USDC * 1e6 * 10% = 100 micro-USDC
});

test("extraLegs hook sees the citation price (legs scale with the priced toll)", async () => {
  const OPERATOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const withFee = publisher({
    extraLegs: (price) => [
      { role: "operator", payTo: walletAddress(OPERATOR), amount: String(Math.round((price as number) * 1e6 * 0.1)) },
    ],
  });
  const q = await quote(withFee, "on-passage", "citation");
  assert.ok(q);
  assert.equal(q.price, 0.005); // 0.001 * 5
  assert.equal(q.extraLegs[0]!.amount, "500"); // fee tracks the citation price
});

test("no memoId hook → quote carries no memoId (back-compat: settle keys off the nonce)", async () => {
  const q = await quote(publisher(), "on-passage", "read");
  assert.ok(q);
  assert.equal(q.memoId, undefined);
  assert.ok(!("memoId" in q), "key absent entirely, not set-to-undefined");
});

test("memoId hook is honored — the control plane's id is carried onto the quote", async () => {
  const withMemo = publisher({ memoId: ({ slug, kind }) => `${kind}:${slug}` });
  const read = await quote(withMemo, "on-passage", "read");
  const cite = await quote(withMemo, "on-passage", "citation");
  assert.equal(read?.memoId, "read:on-passage");
  assert.equal(cite?.memoId, "citation:on-passage"); // the hook sees the kind
});

test("a memoId hook that returns undefined leaves the key absent (opt-out per article)", async () => {
  const q = await quote(publisher({ memoId: () => undefined }), "on-passage", "read");
  assert.ok(q);
  assert.ok(!("memoId" in q), "undefined return is not stamped");
});

test("quote copies the publisher's settlementNetwork onto the Quote (per-tenant chain)", async () => {
  const q = await quote(publisher({ settlementNetwork: "base" }), "on-passage", "read");
  assert.ok(q);
  assert.equal(q.network, "base");
});

test("quote stamps the pricing runtime's active network when the publisher declares none", async () => {
  // The regression this replaces asserted `undefined` here, which read as "downstream falls
  // back to activeNetwork()" — true only when the same PROCESS builds the 402. In API mode the
  // control plane prices and the publisher's own runtime builds, so an absent network was
  // resolved against THAT runtime's env: a fleet on Base quoted arcTestnet USDC to live agents.
  const q = await quote(publisher(), "on-passage", "read");
  assert.ok(q);
  assert.equal(q.network, activeNetwork().chainName);
  assert.ok(q.network !== undefined, "a quote must never leave the chain to the reader to guess");
});

test("an explicit per-tenant chain still beats the runtime default", async () => {
  const other = activeNetwork().chainName === "base" ? "arcTestnet" : "base";
  const q = await quote(publisher({ settlementNetwork: other }), "on-passage", "read");
  assert.ok(q);
  assert.equal(q.network, other);
});

/* ── per-path price rules (W2) ─────────────────────────────────────────────── */

const RULES = [
  { pattern: "/papers/preview$", priceUsdc: 0.0005 },
  { pattern: "/papers/*", priceUsdc: 0.05, citationMultiplier: 20 },
  { pattern: "/notes/*", citationMultiplier: 2 },
];

test("no path, no rules, or no match prices exactly as it did before price rules existed", async () => {
  const base = publisher();
  const ruled = publisher({ priceRules: RULES });
  for (const kind of ["read", "citation"] as const) {
    // A publisher with no rules is unaffected whether or not a path is supplied.
    assert.equal(tollPrice(base, kind, "/papers/x"), tollPrice(base, kind));
    // A publisher WITH rules, priced without a path, falls back to the site values. This is the
    // shape that would refuse a settle if a verifier forgot the argument, so it is pinned.
    assert.equal(tollPrice(ruled, kind), tollPrice(base, kind));
    // A path no rule covers is the site price too.
    assert.equal(tollPrice(ruled, kind, "/blog/x"), tollPrice(base, kind));
  }
});

test("a rule prices the path it covers, for both kinds", () => {
  const p = publisher({ priceRules: RULES });
  assert.equal(tollPrice(p, "read", "/papers/quantum"), 0.05);
  assert.equal(tollPrice(p, "citation", "/papers/quantum"), 1); // 0.05 × 20
});

test("the most specific rule wins, and each field is inherited independently", () => {
  const p = publisher({ priceRules: RULES });
  // /papers/preview matches BOTH rules; the anchored one is more specific and is listed first.
  assert.equal(tollPrice(p, "read", "/papers/preview"), 0.0005);
  // It sets no multiplier, so the citation multiple comes from the SITE (5), not from the
  // less-specific /papers/* rule (20). A rule is an override, not a cascade.
  assert.equal(tollPrice(p, "citation", "/papers/preview"), 0.0025);
  // The mirror case: a rule with only a multiplier keeps the site's read price.
  assert.equal(tollPrice(p, "read", "/notes/x"), 0.001);
  assert.equal(tollPrice(p, "citation", "/notes/x"), 0.002);
});

test("quote() charges what tollPrice says for the same path — the two cannot disagree", async () => {
  const p = publisher({ priceRules: [{ pattern: "/essays/*", priceUsdc: 0.07 }] });
  for (const kind of ["read", "citation"] as const) {
    const q = await quote(p, "on-passage", kind, "/essays/on-passage");
    assert.ok(q);
    assert.equal(q.price, tollPrice(p, kind, "/essays/on-passage"));
  }
  assert.equal((await quote(p, "on-passage", "read", "/essays/on-passage"))?.price, 0.07);
});

test("the rule matches the PATH, never the slug", async () => {
  // The slug here is `on-passage`; the rule names `/essays/*`. A rule keyed on the slug would
  // miss, and in site mode the two only coincide by accident of configuration.
  const p = publisher({ priceRules: [{ pattern: "/on-passage", priceUsdc: 9 }] });
  assert.equal((await quote(p, "on-passage", "read", "/essays/on-passage"))?.price, 0.001);
  assert.equal((await quote(p, "on-passage", "read", "/on-passage"))?.price, 9);
});
