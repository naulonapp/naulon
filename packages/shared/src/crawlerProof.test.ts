import { test } from "node:test";
import assert from "node:assert/strict";
import { CRAWLER_PROOF, claimsIn } from "./crawlerProof.ts";

test("every row is well formed and ids are unique", () => {
  const ids = new Set<string>();
  for (const r of CRAWLER_PROOF) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
    ids.add(r.id);
    assert.ok(r.fragments.length > 0 && r.fragments.every((f) => f === f.toLowerCase()), r.id);
    if (r.kind === "ranges") assert.ok(r.sources.length > 0 && r.sources.every((u) => u.startsWith("https://")), r.id);
    else assert.equal(r.forgedEligible, false, `${r.id}: only a ranges source can produce forged`);
  }
});

test("no fragment belongs to two rows", () => {
  const seen = new Map<string, string>();
  for (const r of CRAWLER_PROOF) for (const f of r.fragments) {
    assert.ok(!seen.has(f), `${f} in ${seen.get(f)} and ${r.id}`);
    seen.set(f, r.id);
  }
});

test("claimsIn finds every operator a UA names, case-insensitively", () => {
  const ua = "Mozilla/5.0 (compatible; DuckDuckBot/1.1; Googlebot/2.1; +http://www.google.com/bot.html)";
  assert.deepEqual(claimsIn(ua).map((c) => c.id).sort(), ["duckduckgo", "google"]);
  assert.deepEqual(claimsIn("Mozilla/5.0 (Macintosh) Safari/605"), []);
  assert.deepEqual(claimsIn("Applebot-Extended/0.1").map((c) => c.id), ["apple"]);
  assert.deepEqual(claimsIn("Claude-User/1.0").map((c) => c.id), ["anthropic"]);
});

test("Perplexity, Amazon, Exa, Meta and ByteDance can never produce forged", () => {
  for (const id of ["perplexity-bot", "perplexity-user", "amazon", "exa", "meta", "bytedance"]) {
    assert.equal(CRAWLER_PROOF.find((r) => r.id === id)?.forgedEligible, false, id);
  }
});
