/**
 * Crawler identity on the gate: a forged allowlisted crawler reads free until the install is
 * armed for that operator, then pays; the real crawler always reads free; a request missing the
 * configured client-IP header is never judged.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-identity-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
process.env.CLIENT_IP_HEADER = "x-test-client-ip";
const OBS_PATH = join(tmpdir(), `naulon-identity-obs-${process.pid}.jsonl`);
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.OBSERVATIONS_BACKEND = "jsonl";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress, compileRanges } = await import("@naulon/shared");
const { MemoryArmingStore } = await import("@naulon/enforce");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;
type CrawlerRangesDocument = import("@naulon/shared").CrawlerRangesDocument;
type RangeFetcher = import("./rangeFetcher.ts").RangeFetcher;

const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const PUB: PublisherConfig = {
  id: "identity-pub",
  originUrl: "http://origin-identity.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      if (slug.endsWith("untolled")) return undefined;
      return { slug, title: `T ${slug}`, contributors: [{ authorId: "a", wallet: AUTHOR_WALLET }] };
    },
  },
  licenseIdentity: "naulon:identity.example",
  crawlerPolicy: { allow: ["googlebot"], block: [] },
};
const resolver: PublisherResolver = { async resolve(host) { return host === "identity.example" ? PUB : undefined; } };

const fresh = new Date(Date.now() - 3_600_000).toISOString();
const doc: CrawlerRangesDocument = {
  version: 1, generatedAt: fresh, proxies: {}, sources: [],
  operators: [{ id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges", forgedEligible: true, fetchedAt: fresh, prefixes: ["66.249.64.0/27"] }],
};
const ranges: RangeFetcher = { current: () => compileRanges(doc), document: () => doc, refresh: async () => {} };
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

/** Observation writes are fire-and-forget, so poll for the row rather than read once. */
async function waitForObs(match: (o: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 50; i++) {
    const rows = existsSync(OBS_PATH) ? readFileSync(OBS_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    const found = rows.findLast(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

const hit = (app: ReturnType<typeof createApp>, ip?: string) =>
  app.request("/essays/piece", {
    headers: { host: "identity.example", "user-agent": GOOGLEBOT, accept: "text/html", ...(ip ? { "x-test-client-ip": ip } : {}) },
  });

test("forged Googlebot reads free until armed, then pays; real Googlebot always free", async () => {
  const arming = new MemoryArmingStore();
  const app = createApp(resolver, { crawlerRanges: ranges, arming });
  assert.equal((await hit(app, "9.9.9.9")).status, 200);
  for (let i = 0; i < 20; i++) assert.equal((await hit(app, "66.249.64.9")).status, 200);
  assert.equal(arming.isArmed("identity-pub", "google"), true);
  assert.equal((await hit(app, "9.9.9.9")).status, 402);
  assert.equal((await hit(app, "66.249.64.9")).status, 200);
});

test("CLIENT_IP_HEADER set but absent: unverified, free, never arms", async () => {
  const arming = new MemoryArmingStore();
  const app = createApp(resolver, { crawlerRanges: ranges, arming });
  for (let i = 0; i < 25; i++) assert.equal((await hit(app)).status, 200);
  assert.equal(arming.isArmed("identity-pub", "google"), false);
});

test("a person's browser never touches the ranges", async () => {
  let reads = 0;
  const counting: RangeFetcher = { ...ranges, current: () => { reads++; return ranges.current(); } };
  const app = createApp(resolver, { crawlerRanges: counting, arming: new MemoryArmingStore() });
  const res = await app.request("/essays/piece", {
    headers: { host: "identity.example", "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", accept: "text/html", "x-test-client-ip": "9.9.9.9" },
  });
  assert.equal(res.status, 200);
  assert.equal(reads, 0);
});

test("a forged claim on an article nobody is credited for still leaves an audit row", async () => {
  const arming = new MemoryArmingStore();
  for (let i = 0; i < 20; i++) arming.record("identity-pub", { check: "ip-verified", claims: [{ operatorId: "google", operator: "Google", fragment: "googlebot", check: "ip-verified" }] }, Date.now());
  assert.equal(arming.isArmed("identity-pub", "google"), true);
  const app = createApp(resolver, { crawlerRanges: ranges, arming });
  const res = await app.request("/essays/untolled", {
    headers: { host: "identity.example", "user-agent": GOOGLEBOT, accept: "text/html", "x-test-client-ip": "9.9.9.9" },
  });
  assert.equal(res.status, 200);
  const row = await waitForObs((r) => r.path === "/essays/untolled");
  assert.ok(row, "no observation for the untolled article");
  assert.equal(row.identityCheck, "forged");
  assert.equal(row.forgedFrom, "9.9.9.0/24");
  assert.equal(row.verdict, "served-free");
});

test("an agent with no crawler claim on an untolled article still writes nothing", async () => {
  const app = createApp(resolver, { crawlerRanges: ranges, arming: new MemoryArmingStore() });
  await app.request("/essays/quiet-untolled", { headers: { host: "identity.example", "user-agent": "GPTBot/1.1", accept: "*/*" } });
  // A row the gate did write lands within waitForObs's window; give this one the same window.
  await new Promise((r) => setTimeout(r, 300));
  const rows = existsSync(OBS_PATH) ? readFileSync(OBS_PATH, "utf8") : "";
  assert.equal(rows.includes("quiet-untolled"), false);
});
