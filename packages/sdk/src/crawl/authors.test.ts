import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAuthorWallet, validWallet } from "./authors.ts";
import type { CrawlConfig, DiscoveredArticle } from "./types.ts";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_D = "0x2222222222222222222222222222222222222222";

function article(authors: string[]): DiscoveredArticle {
  return { slug: "s", url: "https://x/essays/s", title: "T", authors: authors.map((name) => ({ name })) };
}
function config(over: Partial<CrawlConfig> = {}): CrawlConfig {
  return { includeGlobs: [], excludeGlobs: [], authorWalletMap: {}, ...over };
}

test("validWallet accepts a well-formed 0x address, rejects the rest", () => {
  assert.equal(validWallet(WALLET_A), WALLET_A);
  assert.equal(validWallet("0x123"), null);
  assert.equal(validWallet("1111111111111111111111111111111111111111"), null);
  assert.equal(validWallet(undefined), null);
});

test("resolveAuthorWallet maps the primary author via authorWalletMap", () => {
  const r = resolveAuthorWallet(article(["Jane Roe"]), config({ authorWalletMap: { "Jane Roe": WALLET_A } }));
  assert.deepEqual(r, { author: "Jane Roe", wallet: WALLET_A, unmapped: false });
});

test("resolveAuthorWallet falls to defaultWallet when the author is unmapped", () => {
  const r = resolveAuthorWallet(article(["Nobody"]), config({ defaultWallet: WALLET_D }));
  assert.deepEqual(r, { author: "Nobody", wallet: WALLET_D, unmapped: false });
});

test("resolveAuthorWallet falls to defaultWallet when the source stated no author", () => {
  const r = resolveAuthorWallet(article([]), config({ defaultWallet: WALLET_D }));
  assert.deepEqual(r, { author: null, wallet: WALLET_D, unmapped: false });
});

test("resolveAuthorWallet resolves to unmapped when nothing maps (money never inferred)", () => {
  const r = resolveAuthorWallet(article(["Ghost"]), config());
  assert.deepEqual(r, { author: "Ghost", wallet: null, unmapped: true });
});

test("resolveAuthorWallet never tolls to a malformed mapped address", () => {
  const r = resolveAuthorWallet(article(["Jane"]), config({ authorWalletMap: { Jane: "0xnope" }, defaultWallet: WALLET_D }));
  // malformed map entry is rejected — falls through to the valid defaultWallet.
  assert.deepEqual(r, { author: "Jane", wallet: WALLET_D, unmapped: false });
});

test("resolveAuthorWallet is unmapped when both the map entry and default are malformed", () => {
  const r = resolveAuthorWallet(article(["Jane"]), config({ authorWalletMap: { Jane: "0xnope" }, defaultWallet: "bad" }));
  assert.deepEqual(r, { author: "Jane", wallet: null, unmapped: true });
});
