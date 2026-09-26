import { test } from "node:test";
import assert from "node:assert/strict";

import { prohibitedUse } from "./terms-enforcement.ts";

const agent = { classifiedAs: "agent" } as const;
const human = { classifiedAs: "human" } as const;

test("an unstated policy refuses nothing", () => {
  assert.equal(prohibitedUse({ ua: "GPTBot/1.0", ...agent }), null);
  assert.equal(prohibitedUse({ policy: {}, ua: "GPTBot/1.0", ...agent }), null);
});

test("a policy that prohibits nothing refuses nothing", () => {
  const policy = { "ai-input": "priced", "ai-train": "by-agreement", search: "free" } as const;
  assert.equal(prohibitedUse({ policy, ua: "GPTBot/1.0", ...agent }), null);
  assert.equal(prohibitedUse({ policy, ua: "curl/8.4", ...agent }), null);
});

test("a prohibited read refuses every agent, named or not", () => {
  const policy = { "ai-input": "prohibit" } as const;
  assert.equal(prohibitedUse({ policy, ua: "ChatGPT-User/1.0", ...agent })?.term, "ai-input");
  assert.equal(prohibitedUse({ policy, ua: "some-unlisted-agent/2", ...agent })?.term, "ai-input");
  assert.equal(prohibitedUse({ policy, ua: "", ...agent })?.term, "ai-input");
});

test("a human is never refused, whatever the policy says", () => {
  const policy = { "ai-input": "prohibit", "ai-train": "prohibit" } as const;
  assert.equal(prohibitedUse({ policy, ua: "Mozilla/5.0 (Macintosh)", ...human }), null);
});

test("a prohibited training corpus refuses the crawlers that collect one", () => {
  const policy = { "ai-train": "prohibit", "ai-input": "priced" } as const;
  assert.equal(prohibitedUse({ policy, ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", ...agent })?.term, "ai-train");
  assert.equal(prohibitedUse({ policy, ua: "CCBot/2.0", ...agent })?.term, "ai-train");
});

test("a prohibited training corpus still sells a priced read to an assistant", () => {
  const policy = { "ai-train": "prohibit", "ai-input": "priced" } as const;
  assert.equal(prohibitedUse({ policy, ua: "ChatGPT-User/1.0", ...agent }), null);
  assert.equal(prohibitedUse({ policy, ua: "some-unlisted-agent/2", ...agent }), null);
});

test("a rotated user agent does not dodge a training refusal", () => {
  const policy = { "ai-train": "prohibit" } as const;
  const hit = prohibitedUse({ policy, ua: "Mozilla/5.0", verifiedAgent: "gptbot", ...agent });
  assert.equal(hit?.term, "ai-train");
});

test("a prohibited search index refuses a search crawler the allowlist reads as free", () => {
  const policy = { search: "prohibit" } as const;
  assert.equal(prohibitedUse({ policy, ua: "Googlebot/2.1", ...human })?.term, "search");
  assert.equal(prohibitedUse({ policy, ua: "bingbot/2.0", ...human })?.term, "search");
});

test("search free leaves a search crawler alone", () => {
  assert.equal(prohibitedUse({ policy: { search: "free" }, ua: "Googlebot/2.1", ...human }), null);
});

test("a prohibited ai-index is stated in the licence and refuses nothing on the wire", () => {
  const policy = { "ai-index": "prohibit" } as const;
  assert.equal(prohibitedUse({ policy, ua: "ChatGPT-User/1.0", ...agent }), null);
  assert.equal(prohibitedUse({ policy, ua: "GPTBot/1.0", ...agent }), null);
});

test("the refusal names the crawler when one was identified", () => {
  const hit = prohibitedUse({ policy: { "ai-train": "prohibit" }, ua: "GPTBot/1.0", ...agent });
  assert.match(hit?.reason ?? "", /GPTBot/);
  const anon = prohibitedUse({ policy: { "ai-input": "prohibit" }, ua: "whatever/1", ...agent });
  assert.match(anon?.reason ?? "", /ai-input/);
});

test("a per-crawler allow cannot undo a prohibited read for an AI crawler", () => {
  // The allowlist makes the classifier call the crawler a person, which must not be a way past a
  // refused term. A search crawler is not an AI reader and stays under its own term.
  const policy = { "ai-input": "prohibit" } as const;
  assert.equal(prohibitedUse({ policy, ua: "ChatGPT-User/1.0", ...human })?.term, "ai-input");
  assert.equal(prohibitedUse({ policy, ua: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0)", ...human }), null);
});
