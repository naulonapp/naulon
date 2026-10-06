import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationEvent } from "@naulon/shared";

const OBS_PATH = join(tmpdir(), `naulon-observe-mode-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.EVENTS_PATH = join(tmpdir(), `naulon-observe-mode-events-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildMockSignature, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const PUB: PublisherConfig = {
  id: "observer",
  originUrl: "http://origin-observer.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: { async resolve(slug: string) { return { slug, title: slug, contributors: [{ authorId: "a", wallet: AUTHOR }] }; } },
  licenseIdentity: "naulon:observer.example",
  crawlerPolicy: { allow: [], block: ["nastybot"] },
  tollMode: "observe",
};
const app = createApp({ async resolve(host) { return host === "observer.example" ? PUB : undefined; } });

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

const get = (ua: string, extra: Record<string, string> = {}) =>
  app.request("/essays/piece", { headers: { host: "observer.example", "user-agent": ua, ...extra } });

async function rows(match: (o: ObservationEvent) => boolean): Promise<ObservationEvent | undefined> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const all = (await readFile(OBS_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as ObservationEvent);
      const hit = all.find(match);
      if (hit) return hit;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

test("observe: an unpaid agent is proxied, not 402'd, and recorded observe-only with its budget", async () => {
  const res = await get("GPTBot/1.0", { "crawler-max-price": "USD 0.0001" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("payment-required"), null);
  const r = await rows((o) => o.verdict === "denied" && o.crawlerBudget === "over");
  assert.ok(r, "an observe-only denied row with crawlerBudget over");
  assert.equal(r.observeOnly, true);
});

test("observe: a presented payment is not settled", async () => {
  const res = await get("GPTBot/1.0", { [PAYMENT_SIGNATURE_HEADER]: buildMockSignature(PAYER, "1000") });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("payment-response"), null, "no settlement receipt in observe");
  const r = await rows((o) => o.paymentPresented === true);
  assert.ok(r);
  assert.equal(r.observeOnly, true);
});

test("observe: a blocked crawler presenting payment is still refused", async () => {
  const res = await get("NastyBot/1.0", { [PAYMENT_SIGNATURE_HEADER]: buildMockSignature(PAYER, "1000") });
  assert.equal(res.status, 403);
});

test("charge: the stated budget is recorded on an ordinary 402", async () => {
  const enforcing = createApp({ async resolve() { return { ...PUB, id: "enforcer", tollMode: undefined }; } });
  const res = await enforcing.request("/essays/other", { headers: { host: "observer.example", "user-agent": "GPTBot/1.0", "crawler-max-price": "USD 1" } });
  assert.equal(res.status, 402);
  const r = await rows((o) => o.publisherId === "enforcer" && o.crawlerBudget === "within");
  assert.ok(r);
  assert.equal(r.observeOnly, undefined);
});

test("observe: a site with nobody to pay is proxied and priced at its own price", async () => {
  const nobody = { ...PUB, id: "nobody", credits: { async resolve(slug: string) { return { slug, title: slug, contributors: [{ authorId: "a" }] }; } } };
  const gate = createApp({ async resolve() { return nobody; } });
  const res = await gate.request("/essays/unpaid", { headers: { host: "observer.example", "user-agent": "GPTBot/1.0", "crawler-max-price": "USD 0.0005" } });
  assert.equal(res.status, 200);
  const r = await rows((o) => o.publisherId === "nobody");
  assert.ok(r);
  assert.equal(r.observeOnly, true);
  assert.equal(r.crawlerBudget, "over");
});
