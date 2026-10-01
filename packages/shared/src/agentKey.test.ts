import { test } from "node:test";
import assert from "node:assert/strict";
import { agentKey, registryCrawler } from "./crawlerRegistry.ts";

test("agentKey: every spelling of one crawler counts under its registry name", () => {
  const spellings = [
    "GPTBot/1.0",
    "gptbot/1.0 (+https://openai.com/gptbot)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  ];
  assert.deepEqual(new Set(spellings.map((ua) => agentKey({ agentUa: ua }))), new Set(["GPTBot"]));
});

test("agentKey: a verified identity outranks the UA, and an unknown client keeps its own string", () => {
  assert.equal(agentKey({ agentUa: "Mozilla/5.0 (Macintosh)", verifiedAgent: "chatgpt.com" }), "chatgpt.com");
  assert.equal(agentKey({ agentUa: "curl/8.7.1" }), "curl/8.7.1");
  assert.equal(agentKey({}), "(unknown agent)");
});

test("registryCrawler: the more specific fragment wins, and one signing host is split by its UA", () => {
  assert.equal(registryCrawler({ agentUa: "Applebot-Extended/0.1" })?.id, "applebot-extended");
  assert.equal(registryCrawler({ agentUa: "Mozilla/5.0; ChatGPT-User/1.0", verifiedAgent: "chatgpt.com" })?.id, "chatgpt-user");
  assert.equal(registryCrawler({ verifiedAgent: "chatgpt.com" })?.operator, "OpenAI");
  assert.equal(registryCrawler({ agentUa: "python-requests/2.32" }), null);
});
