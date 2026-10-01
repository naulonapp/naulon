import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRanges } from "@naulon/shared";
import { decide } from "./decide.ts";
import type { IdentityInput } from "./identity.ts";

const NOW = Date.UTC(2026, 9, 1);
const fresh = new Date(NOW - 3_600_000).toISOString();
const ranges = compileRanges({
  version: 1, generatedAt: fresh, proxies: {}, sources: [],
  operators: [{ id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges", forgedEligible: true, fetchedAt: fresh, prefixes: ["66.249.64.0/27"] }],
});
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const basePublisher = {
  id: "pub_test",
  originUrl: "http://origin.local",
  articlePrefixes: ["essays"],
  seoAllowlist: [],
  licenseIdentity: "did:web:test",
  gateScope: undefined,
  suspended: false,
} as any;

const quoteOf = async () =>
  ({
    slug: "essays/x",
    kind: "read",
    title: "X",
    price: 5000,
    payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
    extraLegs: [],
    coauthorSplit: false,
  }) as any;

const id = (clientIp: string, armed: boolean): IdentityInput => ({ ranges, clientIp, now: NOW, isArmed: () => armed });

async function run(opts: { ip: string; armed: boolean; forged?: "charge" | "block"; mode?: "off" | "auto"; aiInputFree?: boolean }) {
  const publisher = {
    ...basePublisher,
    crawlerPolicy: { allow: ["googlebot"], block: [], ...(opts.forged ? { forged: opts.forged } : {}) },
    ...(opts.mode ? { identityMode: opts.mode } : {}),
    ...(opts.aiInputFree ? { termsPolicy: { "ai-input": "free" } } : {}),
  };
  const raw = new Request("http://h/essays/x", { headers: { "user-agent": GOOGLEBOT, accept: "text/html" } });
  return decide({ raw, host: "h", path: "/essays/x", publisher, now: NOW, quote: quoteOf, identity: id(opts.ip, opts.armed) });
}

test("armed + forged + allowlisted: 402, with the identity on the observation", async () => {
  const d = await run({ ip: "9.9.9.9", armed: true });
  assert.equal(d.kind, "payment-required");
  assert.equal(d.obs.identity?.check, "forged");
  assert.equal(d.obs.forgedFrom, "9.9.9.0/24");
});

test("unarmed + forged: free, still recorded", async () => {
  const d = await run({ ip: "9.9.9.9", armed: false });
  assert.equal(d.kind, "free");
  assert.equal(d.obs.identity?.check, "forged");
});

test("real Googlebot: free, ip-verified, no forgedFrom", async () => {
  const d = await run({ ip: "66.249.64.9", armed: true });
  assert.equal(d.kind, "free");
  assert.equal(d.obs.identity?.check, "ip-verified");
  assert.equal(d.obs.forgedFrom, undefined);
});

test("forged: block returns the 403 shape with the claimed fragment", async () => {
  const d = await run({ ip: "9.9.9.9", armed: true, forged: "block" });
  assert.equal(d.kind, "blocked");
  if (d.kind === "blocked") assert.equal(d.frag, "googlebot");
});

test("identityMode off: no identity on the observation, free as before", async () => {
  const d = await run({ ip: "9.9.9.9", armed: true, mode: "off" });
  assert.equal(d.kind, "free");
  assert.equal(d.obs.identity, undefined);
});

test("a site that gives ai-input away still reads free to a forged agent", async () => {
  const d = await run({ ip: "9.9.9.9", armed: true, aiInputFree: true });
  assert.equal(d.kind, "free");
});
