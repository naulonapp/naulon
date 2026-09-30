import assert from "node:assert/strict";
import { test } from "node:test";
import { referrerHost } from "./referrer.ts";

test("referrerHost keeps only another site's host", () => {
  assert.equal(referrerHost("https://chatgpt.com/c/abc?x=1", "p.example"), "chatgpt.com");
  assert.equal(referrerHost("https://WWW.Perplexity.ai/search/q", "p.example"), "www.perplexity.ai");
  assert.equal(referrerHost("https://p.example/other", "P.example:443"), undefined);
  assert.equal(referrerHost("not a url", "p.example"), undefined);
  assert.equal(referrerHost(null, "p.example"), undefined);
});
