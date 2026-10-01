import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRanges, type CrawlerRangesDocument } from "@naulon/shared";
import { checkIdentity, classifyWithIdentity, decidingClaim, type IdentityInput } from "./identity.ts";
import type { RequestSignals } from "./agentDetect.ts";

const NOW = Date.UTC(2026, 9, 1);
const fresh = new Date(NOW - 3_600_000).toISOString();
const doc: CrawlerRangesDocument = {
  version: 1, generatedAt: fresh, proxies: { cloudflare: ["173.245.48.0/20"] }, sources: [],
  operators: [
    { id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges", forgedEligible: true, fetchedAt: fresh, prefixes: ["66.249.64.0/27"] },
    { id: "duckduckgo", operator: "DuckDuckGo", fragments: ["duckduckbot"], kind: "ranges", forgedEligible: true, fetchedAt: fresh, prefixes: ["20.191.45.212/32"] },
    { id: "meta", operator: "Meta", fragments: ["meta-externalagent"], kind: "none", forgedEligible: false, fetchedAt: null, prefixes: [] },
  ],
};
const ranges = compileRanges(doc);
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const sig = (ua: string): RequestSignals => ({ userAgent: ua, hasPaymentHeader: false, declaredAgentId: null, accept: "text/html", headers: {} });
const input = (clientIp: string | null, armed: string[] = ["google"], over: Partial<IdentityInput> = {}): IdentityInput => ({
  ranges, clientIp, now: NOW, isArmed: (op) => armed.includes(op), ...over,
});

test("no crawler named: no identity result", () => {
  assert.equal(checkIdentity("Mozilla/5.0 Safari", null, input("9.9.9.9")), undefined);
});

test("inside ranges: ip-verified; outside and fresh: forged", () => {
  assert.equal(checkIdentity(GOOGLEBOT, null, input("66.249.64.5"))?.check, "ip-verified");
  assert.equal(checkIdentity(GOOGLEBOT, null, input("9.9.9.9"))?.check, "forged");
});

test("missing inputs never accuse", () => {
  assert.equal(checkIdentity(GOOGLEBOT, null, input(null))?.check, "unverified");
  assert.equal(checkIdentity(GOOGLEBOT, null, input("10.0.0.5"))?.check, "unverified");
  assert.equal(checkIdentity(GOOGLEBOT, null, { ...input("9.9.9.9"), ranges: null })?.check, "unverified");
  assert.equal(checkIdentity(GOOGLEBOT, null, { ...input("9.9.9.9"), now: NOW + 8 * 86_400_000 })?.check, "unverified");
  assert.equal(checkIdentity("meta-externalagent/1.1", null, input("9.9.9.9"))?.check, "unverified");
});

test("a proxy's address is never a caller: a runtime that reads the wrong header cannot accuse", () => {
  // A real crawler never originates inside a CDN's own ranges. Reading the proxy's header correctly
  // yields the caller's address, which is outside them; reading the wrong one yields the proxy's.
  assert.equal(checkIdentity(GOOGLEBOT, null, input("173.245.48.9", ["google"]))?.check, "unverified");
});

test("a signature backs only the claim whose registry directory signed it", () => {
  // Any host can publish a key directory; signing proves who signed, not that this is Googlebot.
  assert.equal(checkIdentity(GOOGLEBOT, "crawler.example", input("9.9.9.9"))?.check, "forged");
  assert.equal(checkIdentity(GOOGLEBOT, "chatgpt.com", input("66.249.64.5"))?.check, "ip-verified");
  assert.equal(checkIdentity("ChatGPT-User/1.0", "chatgpt.com", { ...input("9.9.9.9"), ranges: null })?.check, "signature");
  assert.equal(checkIdentity("ChatGPT-User/1.0", "agents.chatgpt.com", { ...input("9.9.9.9"), ranges: null })?.check, "signature");
  assert.equal(checkIdentity("ChatGPT-User/1.0", "chatgpt.com.evil.example", { ...input("9.9.9.9"), ranges: null })?.check, "unverified");
});

test("two claims: the worst wins (H5)", () => {
  const r = checkIdentity("DuckDuckBot/1.1 Googlebot/2.1", null, input("20.191.45.212"));
  assert.equal(r?.check, "forged");
  assert.deepEqual(r?.claims.map((c) => [c.operatorId, c.check]), [["google", "forged"], ["duckduckgo", "ip-verified"]]);
});

test("classifyWithIdentity: armed forged allowlisted claim is an agent, not browser-shaped (H1, H2)", () => {
  const out = classifyWithIdentity(sig(GOOGLEBOT), { seoAllowlist: ["googlebot"] }, "auto", input("9.9.9.9"));
  assert.equal(out.verdict.kind, "agent");
  assert.equal(out.verdict.identity, "forged");
  assert.match(out.verdict.reason, /outside Google's published ranges/);
});

test("classifyWithIdentity: unarmed forged claim stays free and is recorded", () => {
  const out = classifyWithIdentity(sig(GOOGLEBOT), { seoAllowlist: ["googlebot"] }, "auto", input("9.9.9.9", []));
  assert.equal(out.verdict.kind, "human");
  assert.equal(out.identity?.check, "forged");
  assert.equal(out.forgedClaim, undefined);
});

test("classifyWithIdentity: an unverifiable allowlist hit cannot shield a forged claim (H5)", () => {
  const out = classifyWithIdentity(sig("DuckDuckBot/1.1 Googlebot/2.1"), { seoAllowlist: ["duckduckbot", "googlebot"] }, "auto", input("20.191.45.212"));
  assert.equal(out.verdict.kind, "agent");
});

test("classifyWithIdentity: mode off computes nothing", () => {
  const out = classifyWithIdentity(sig(GOOGLEBOT), { seoAllowlist: ["googlebot"] }, "off", input("9.9.9.9"));
  assert.equal(out.verdict.kind, "human");
  assert.equal(out.identity, undefined);
});

test("classifyWithIdentity: forged on a charged crawler changes nothing but is recorded", () => {
  const gpt = compileRanges({ ...doc, operators: [{ id: "openai-gptbot", operator: "OpenAI", fragments: ["gptbot"], kind: "ranges", forgedEligible: true, fetchedAt: fresh, prefixes: ["4.227.36.0/25"] }] });
  const out = classifyWithIdentity(sig("GPTBot/1.1"), undefined, "auto", { ...input("9.9.9.9", ["openai-gptbot"]), ranges: gpt });
  assert.equal(out.verdict.kind, "agent");
  assert.equal(out.verdict.identity, undefined);
  assert.equal(out.identity?.check, "forged");
});

test("M1: decidingClaim names the claim that set the overall check, not table order", () => {
  const r = checkIdentity("DuckDuckBot/1.1 Googlebot/2.1", null, input("20.191.45.212"))!;
  assert.equal(r.claims[0]?.operatorId, "google");
  assert.equal(decidingClaim(r)?.operatorId, "google");
  const r2 = checkIdentity("DuckDuckBot/1.1 Googlebot/2.1", null, input("66.249.64.5"))!;
  // Google verifies, DuckDuckGo is forged: the forged one decides even though Google is listed first.
  assert.equal(r2.check, "forged");
  assert.equal(decidingClaim(r2)?.operatorId, "duckduckgo");
});
