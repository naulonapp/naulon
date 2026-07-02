/**
 * The embedding seam, executed: `createApp(resolver)` routes, prices, and
 * attributes a request entirely from the resolved publisher's config. Two configs
 * keyed by Host prove the gate reads the injected resolver rather than anything
 * baked in — the "publisher-agnostic" claim as a test, not a promise. (Sourcing a
 * config from a database instead of this in-memory map is a downstream concern,
 * out of scope for this core.)
 *
 * Env is set BEFORE importing the app so config binds mock mode + a tmp ledger.
 * Licenses are off — this exercises routing/pricing/attribution, not the receipt
 * path (payflow.test.ts covers that).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-publisher-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { PAYMENT_REQUIRED_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;
type ArticleCredits = import("@naulon/shared").ArticleCredits;

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A trivial in-memory credits source — one article per publisher. */
function singleArticle(credits: ArticleCredits): { resolve(slug: string): Promise<ArticleCredits | undefined> } {
  return { async resolve(slug) { return slug === credits.slug ? credits : undefined; } };
}

const PUBLISHER_A: PublisherConfig = {
  id: "alpha",
  originUrl: "http://origin-a.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: singleArticle({
    slug: "stillness",
    title: "On Stillness",
    contributors: [{ authorId: "anna", wallet: walletAddress(WALLET_A) }],
  }),
  licenseIdentity: "naulon:a.example",
  settlementSecret: undefined,
};

const PUBLISHER_B: PublisherConfig = {
  id: "beta",
  originUrl: "http://origin-b.local",
  articlePrefixes: ["posts"],
  price: usdc(0.002),
  citationMultiplier: 5,
  credits: singleArticle({
    slug: "flux",
    title: "On Flux",
    contributors: [{ authorId: "ben", wallet: walletAddress(WALLET_B) }],
  }),
  licenseIdentity: "naulon:b.example",
  settlementSecret: undefined,
};

// A publisher whose prefix carries a regex metachar — a DB-backed resolver can feed
// any string here, so the gate must treat it as a literal path segment.
const PUBLISHER_C: PublisherConfig = {
  id: "gamma",
  originUrl: "http://origin-c.local",
  articlePrefixes: ["a.b"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: singleArticle({
    slug: "z",
    title: "Z",
    contributors: [{ authorId: "cara", wallet: walletAddress(WALLET_A) }],
  }),
  licenseIdentity: "naulon:c.example",
  settlementSecret: undefined,
};

/** Route by Host; an unrecognized host returns undefined (gate → 502). */
const resolver: PublisherResolver = {
  async resolve(host) {
    if (host === "a.example") return PUBLISHER_A;
    if (host === "b.example") return PUBLISHER_B;
    if (host === "c.example") return PUBLISHER_C;
    return undefined;
  },
};

const app = createApp(resolver);

const realFetch = globalThis.fetch;
let lastTarget = "";
before(() => {
  // Capture where the gate proxies so passthrough tests can assert the origin.
  globalThis.fetch = (async (input: Request | string | URL) => {
    lastTarget = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** The first `accepts` entry of a 402 — carries atomic amount + the primary payTo. */
function accepts(res: Response): { amount: string; payTo: string } {
  const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
  assert.ok(header, "402 carries PAYMENT-REQUIRED");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: Array<{ amount: string; payTo: string }>;
  };
  return decoded.accepts[0]!;
}

test("an agent on publisher A is priced and attributed as publisher A", async () => {
  const res = await app.request("/essays/stillness", {
    headers: { host: "a.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 402);
  const a = accepts(res);
  assert.equal(a.amount, "1000", "A's read price is 0.001 USDC = 1000 atomic");
  assert.equal(a.payTo.toLowerCase(), WALLET_A, "settles to A's author");
});

test("the SAME core prices and attributes publisher B differently", async () => {
  const res = await app.request("/posts/flux", {
    headers: { host: "b.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 402);
  const b = accepts(res);
  assert.equal(b.amount, "2000", "B's read price is 0.002 USDC = 2000 atomic");
  assert.equal(b.payTo.toLowerCase(), WALLET_B, "settles to B's author");
});

test("article prefixes are per-publisher: B's prefix is not an article on A", async () => {
  // /posts/* is gateable on B but a plain passthrough on A (A gates /essays/*).
  const res = await app.request("/posts/flux", {
    headers: { host: "a.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 200, "passed through, not gated");
  assert.match(lastTarget, /origin-a\.local/, "proxied to A's origin, not B's");
});

test("a human reads publisher B free, proxied to B's origin", async () => {
  const res = await app.request("/posts/flux", {
    headers: { host: "b.example", "user-agent": "Mozilla/5.0 (human browser)", accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /human/);
  assert.match(lastTarget, /origin-b\.local/);
});

test("a prefix with a regex metachar matches literally, not as a pattern", async () => {
  // /a.b/z IS the gated article.
  const gated = await app.request("/a.b/z", {
    headers: { host: "c.example", "x-naulon-agent": "tester" },
  });
  assert.equal(gated.status, 402, "the literal prefix gates");

  // /axb/z must NOT match (the `.` is not a wildcard) — passthrough to origin.
  const passthrough = await app.request("/axb/z", {
    headers: { host: "c.example", "x-naulon-agent": "tester" },
  });
  assert.equal(passthrough.status, 200, "a `.`-as-wildcard match would wrongly gate this");
  assert.match(lastTarget, /origin-c\.local/);
});

test("an unrecognized host is refused, never misrouted", async () => {
  const res = await app.request("/essays/stillness", {
    headers: { host: "unknown.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 502, "unknown host fails closed");
});
