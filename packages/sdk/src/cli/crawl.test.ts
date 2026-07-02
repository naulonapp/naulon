import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrawlFlags, planCrawlInputs } from "./crawl.ts";

test("parseCrawlFlags reads a positional origin + flags", () => {
  const f = parseCrawlFlags(["https://site.com", "--prefixes", "essays,posts", "--default-wallet", "0xabc", "--dry-run"]);
  assert.equal(f.origin, "https://site.com");
  assert.equal(f.prefixes, "essays,posts");
  assert.equal(f.defaultWallet, "0xabc");
  assert.equal(f.dryRun, true);
});

test("planCrawlInputs prefers flags, falls back to .env", () => {
  const env = { ORIGIN_URL: "https://from-env.com", ARTICLE_PATH_PREFIXES: "essays", CREDITS_FIXTURES: "./c.json" };
  const p = planCrawlInputs(parseCrawlFlags(["--prefixes", "articles"]), env, "{}");
  assert.equal(p.origin, "https://from-env.com"); // from env
  assert.deepEqual(p.articlePrefixes, ["articles"]); // flag wins
  assert.equal(p.creditsPath, "./c.json");
});

test("planCrawlInputs throws a helpful error when no origin is resolvable", () => {
  assert.throws(() => planCrawlInputs(parseCrawlFlags([]), {}, "{}"), /origin/i);
});

test("planCrawlInputs auto-allows private for a loopback origin", () => {
  const p = planCrawlInputs(parseCrawlFlags(["http://localhost:3000", "--prefixes", "essays"]), {}, "{}");
  assert.equal(p.allowPrivate, true);
});

test("planCrawlInputs does NOT auto-allow private for a public origin", () => {
  const p = planCrawlInputs(parseCrawlFlags(["https://site.com", "--prefixes", "essays"]), {}, "{}");
  assert.equal(p.allowPrivate, false);
});

test("planCrawlInputs parses an existing credits.json into the map", () => {
  const p = planCrawlInputs(
    parseCrawlFlags(["https://site.com", "--prefixes", "essays"]),
    {},
    JSON.stringify({ x: { slug: "x", title: "X", contributors: [{ authorId: "a", wallet: "0x" + "1".repeat(40) }] } }),
  );
  assert.deepEqual(Object.keys(p.existing), ["x"]);
});

test("planCrawlInputs treats a missing credits file (null) as an empty map", () => {
  const p = planCrawlInputs(parseCrawlFlags(["https://site.com", "--prefixes", "essays"]), {}, null);
  assert.deepEqual(p.existing, {});
});

test("planCrawlInputs threads default wallet + feed url + forced adapter into config", () => {
  const p = planCrawlInputs(
    parseCrawlFlags(["https://site.com", "--prefixes", "essays", "--default-wallet", "0xD", "--feed-url", "https://site.com/f", "--adapter", "rss"]),
    {},
    "{}",
  );
  assert.equal(p.config.defaultWallet, "0xD");
  assert.equal(p.config.feedUrl, "https://site.com/f");
  assert.equal(p.forceAdapterId, "rss");
});
