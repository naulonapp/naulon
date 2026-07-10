import assert from "node:assert/strict";
import { test } from "node:test";
import {
  usdc,
  walletAddress,
  type ArticleCredits,
  type CreditsResolver,
  type PublisherConfig,
} from "@naulon/shared";
import { quote } from "./pricing.ts";

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
    settlementSecret: undefined,
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
