/**
 * Cache discipline on gateable routes (FG hardening H1) + verdict sanitize (H2).
 *
 * Every gateable-route decision is User-Agent-dependent, so a shared cache keying
 * on URL alone could hand a human's 200 to an agent (free read) or an agent's
 * 402/403 to a human (a paywall on the open web). Under test: `Vary: User-Agent`
 * on every decision, merged into an origin Vary; `no-store` on money-bearing
 * states only; passthroughs untouched; header text sanitized.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-cachehard-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp, headerSafe } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const stubCredits = {
  async resolve(slug: string) {
    return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "a", wallet: AUTHOR_WALLET }] };
  },
};

const PUB: PublisherConfig = {
  id: "cachepub",
  originUrl: "http://origin-cache.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: stubCredits,
  licenseIdentity: "naulon:cache.example",
  crawlerPolicy: { allow: [], block: ["nastybot"] },
};

const app = createApp({ async resolve(host) { return host === "cache.example" ? PUB : undefined; } });

/** Origin stub; `originVary` lets a test simulate an origin that already varies. */
let originVary: string | undefined;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", {
      status: 200,
      headers: { "content-type": "text/html", ...(originVary ? { vary: originVary } : {}) },
    })) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

function get(ua: string, path = "/essays/piece", extra: Record<string, string> = {}) {
  return app.request(path, { headers: { host: "cache.example", "user-agent": ua, accept: "text/html", ...extra } });
}

test("agent 402 is uncacheable and varies on UA", async () => {
  const res = await get("GPTBot/1.0");
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("vary"), "User-Agent");
});

test("blocked 403 is uncacheable and varies on UA", async () => {
  const res = await get("NastyBot/1.0");
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("vary"), "User-Agent");
});

test("human free 200 varies on UA but keeps the origin's cache policy", async () => {
  const res = await get("Mozilla/5.0 Firefox/128.0");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("vary") ?? "", /user-agent/i);
  // The gate must NOT force no-store onto the publisher's own pages.
  assert.notEqual(res.headers.get("cache-control"), "no-store");
});

test("an origin-set Vary is merged, not clobbered — and never duplicated", async () => {
  originVary = "Accept-Encoding";
  const merged = await get("Mozilla/5.0 Firefox/128.0");
  assert.equal(merged.headers.get("vary"), "Accept-Encoding, User-Agent");

  originVary = "User-Agent";
  const dup = await get("Mozilla/5.0 Firefox/128.0");
  assert.equal(dup.headers.get("vary"), "User-Agent");

  originVary = "*";
  const star = await get("Mozilla/5.0 Firefox/128.0");
  assert.equal(star.headers.get("vary"), "*", "Vary: * already covers UA — appending would be noise");
  originVary = undefined;
});

test("paid 200 is uncacheable — paid content is a per-request artifact", async () => {
  const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
  // The real x402 dance: take the 402's quote, sign its nonce, re-request.
  const quoted = await get("GPTBot/1.0");
  assert.equal(quoted.status, 402);
  const required = JSON.parse(
    Buffer.from(quoted.headers.get(PAYMENT_REQUIRED_HEADER)!, "base64").toString(),
  ) as { accepts: Array<{ amount: string; extra: { nonce: string } }> };
  const accept = required.accepts[0]!;
  const sig = buildMockSignature("0x1234567890abcdef1234567890abcdef12345678", accept.amount, accept.extra.nonce);
  const res = await get("GPTBot/1.0", "/essays/piece", { [PAYMENT_SIGNATURE_HEADER]: sig });
  assert.equal(res.status, 200, "a signed mock payment settles");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("vary") ?? "", /user-agent/i);
});

test("passthrough routes are untouched — same bytes for every caller", async () => {
  for (const ua of ["Mozilla/5.0 Firefox/128.0", "GPTBot/1.0"]) {
    const res = await get(ua, "/about");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("vary"), null, `${ua} on a non-article path must not gain Vary`);
  }
});

test("headerSafe strips C0 controls + DEL, keeps legal header text", () => {
  assert.equal(headerSafe("blocked (\"bad\r\nbot\")"), 'blocked ("bad  bot")');
  assert.equal(headerSafe("tab\tand\x00nul\x7f"), "tab and nul ");
  assert.equal(headerSafe('human (seo allowlist matched "legacy-bot v2")'), 'human (seo allowlist matched "legacy-bot v2")');
});
