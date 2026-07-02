import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCredits } from "./credits-file.ts";
import type { ArticleCredits } from "../contract/credits.ts";
import { walletAddress } from "../contract/wallet.ts";
import type { CrawlConfig, DiscoveredArticle } from "./types.ts";

const W_A = walletAddress("0x1111111111111111111111111111111111111111");
const W_D = walletAddress("0x2222222222222222222222222222222222222222");

function art(slug: string, authors: string[], title = "T"): DiscoveredArticle {
  return { slug, url: `https://x/essays/${slug}`, title, authors: authors.map((name) => ({ name })) };
}
function cfg(over: Partial<CrawlConfig> = {}): CrawlConfig {
  return { includeGlobs: [], excludeGlobs: [], authorWalletMap: {}, ...over };
}

test("mergeCredits drafts a valid ArticleCredits entry for a mapped author", () => {
  const r = mergeCredits({}, [art("on-stillness", ["Jane Roe"])], cfg({ authorWalletMap: { "Jane Roe": W_A } }));
  assert.deepEqual(r.added, ["on-stillness"]);
  assert.deepEqual(r.credits["on-stillness"], {
    slug: "on-stillness",
    title: "T",
    contributors: [{ authorId: "Jane Roe", wallet: W_A }],
  });
});

test("mergeCredits NEVER writes an unmapped article (money is never inferred)", () => {
  const r = mergeCredits({}, [art("ghost", ["Nobody"])], cfg());
  assert.deepEqual(r.added, []);
  assert.equal(r.credits["ghost"], undefined);
  assert.deepEqual(r.unmapped, [{ slug: "ghost", author: "Nobody" }]);
});

test("mergeCredits is insert-only — an existing slug is never clobbered", () => {
  const existing: Record<string, ArticleCredits> = {
    "on-stillness": { slug: "on-stillness", title: "Hand-edited", contributors: [{ authorId: "me", wallet: W_A }] },
  };
  const r = mergeCredits(existing, [art("on-stillness", ["Jane Roe"], "Crawled Title")], cfg({ defaultWallet: W_D }));
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.keptExisting, ["on-stillness"]);
  // the human-edited entry survives byte-for-byte
  assert.deepEqual(r.credits["on-stillness"], existing["on-stillness"]);
});

test("mergeCredits falls to defaultWallet and uses the author name as authorId", () => {
  const r = mergeCredits({}, [art("x", ["A. Writer"])], cfg({ defaultWallet: W_D }));
  assert.deepEqual(r.credits["x"]!.contributors, [{ authorId: "A. Writer", wallet: W_D }]);
});

test("mergeCredits gives a no-author article a generic authorId under defaultWallet", () => {
  const r = mergeCredits({}, [art("x", [])], cfg({ defaultWallet: W_D }));
  assert.equal(r.credits["x"]!.contributors[0]!.wallet, W_D);
  assert.equal(r.credits["x"]!.contributors[0]!.authorId.length > 0, true);
});

test("mergeCredits falls back to the slug when the title is empty (sitemap)", () => {
  const r = mergeCredits({}, [art("my-post", ["A"], "")], cfg({ authorWalletMap: { A: W_A } }));
  assert.equal(r.credits["my-post"]!.title, "my-post");
});

test("mergeCredits preserves other existing entries and adds only the new", () => {
  const existing: Record<string, ArticleCredits> = {
    old: { slug: "old", title: "Old", contributors: [{ authorId: "x", wallet: W_A }] },
  };
  const r = mergeCredits(existing, [art("new", ["A"])], cfg({ authorWalletMap: { A: W_A } }));
  assert.deepEqual(Object.keys(r.credits).sort(), ["new", "old"]);
  assert.deepEqual(r.added, ["new"]);
});

test("mergeCredits every drafted entry validates against the real credits schema", () => {
  // If an entry were malformed, mergeCredits would throw — reaching here proves it validated.
  const r = mergeCredits({}, [art("a", ["A"]), art("b", [])], cfg({ authorWalletMap: { A: W_A }, defaultWallet: W_D }));
  assert.deepEqual(r.added.sort(), ["a", "b"]);
});
