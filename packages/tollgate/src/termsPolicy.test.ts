/**
 * Stated terms, enforced on the wire: a use the publisher prohibits is refused 403 before any
 * content leaves, a person is never refused, and a term the publisher priced still sells.
 *
 * The gate has always enforced WHO may read (`crawlerPolicy`). This covers WHAT they may do with
 * what they read, which is the axis a publisher states in `termsPolicy` and which every RSL
 * document has carried without anything acting on it.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-termspolicy-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type TermsPolicy = import("@naulon/shared").TermsPolicy;

const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const stubCredits = {
  async resolve(slug: string) {
    return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "testauthor", wallet: AUTHOR_WALLET }] };
  },
};

const base: PublisherConfig = {
  id: "declared",
  originUrl: "http://origin-declared.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: stubCredits,
  licenseIdentity: "naulon:declared.example",
};

function appFor(termsPolicy?: TermsPolicy) {
  const pub: PublisherConfig = { ...base, ...(termsPolicy ? { termsPolicy } : {}) };
  return createApp({ async resolve() { return pub; } });
}

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })
  ) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function get(app: ReturnType<typeof createApp>, ua: string, extra: Record<string, string> = {}) {
  return app.request("/essays/piece", { headers: { host: "declared.example", "user-agent": ua, ...extra } });
}

test("an unstated policy leaves every verdict where it was", async () => {
  const app = appFor();
  assert.equal((await get(app, "GPTBot/1.0")).status, 402);
  assert.equal((await get(app, "Mozilla/5.0 Firefox/128.0", { accept: "text/html" })).status, 200);
});

test("a prohibited agent read is refused, and the verdict names the term", async () => {
  const app = appFor({ "ai-input": "prohibit" });
  const res = await get(app, "GPTBot/1.0");
  assert.equal(res.status, 403);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /prohibited \(ai-input\)/);
  assert.match(await res.text(), /prohibits ai-input/);
});

test("payment does not buy past a prohibition", async () => {
  const app = appFor({ "ai-input": "prohibit" });
  assert.equal((await get(app, "GPTBot/1.0", { "x-payment": "deadbeef" })).status, 403);
});

test("an unlisted agent is refused too, so a user agent nobody knows is not a way through", async () => {
  const app = appFor({ "ai-input": "prohibit" });
  assert.equal((await get(app, "Mozilla/5.0", { "x-naulon-agent": "unlisted-crawler" })).status, 403);
});

test("a person reads a prohibiting site exactly as before", async () => {
  const app = appFor({ "ai-input": "prohibit", "ai-train": "prohibit", search: "prohibit" });
  const res = await get(app, "Mozilla/5.0 Firefox/128.0", { accept: "text/html" });
  assert.equal(res.status, 200);
});

test("prohibiting training refuses a corpus crawler and still sells the priced read", async () => {
  const app = appFor({ "ai-train": "prohibit", "ai-input": "priced" });
  assert.equal((await get(app, "CCBot/2.0")).status, 403);
  assert.equal((await get(app, "GPTBot/1.0")).status, 403);
  assert.equal((await get(app, "ChatGPT-User/1.0")).status, 402);
});

test("prohibiting search refuses a search crawler that would otherwise read free", async () => {
  const free = appFor({ search: "free" });
  const refused = appFor({ search: "prohibit" });
  assert.equal((await get(free, "Googlebot/2.1")).status, 200);
  assert.equal((await get(refused, "Googlebot/2.1")).status, 403);
});

test("a prohibition applies to gateable routes only", async () => {
  const app = appFor({ "ai-input": "prohibit" });
  const res = await app.request("/about", { headers: { host: "declared.example", "user-agent": "GPTBot/1.0" } });
  assert.equal(res.status, 200);
});
