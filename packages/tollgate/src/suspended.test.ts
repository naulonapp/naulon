/**
 * Suspended ≠ dead. A paused publisher (PublisherConfig.suspended) serves its
 * origin straight through — free and untolled — so suspension never darks a live
 * site. This is distinct from an UNKNOWN host, which still fails closed (not
 * served): a paused publisher is known and has an origin to serve.
 *
 * Env is set BEFORE importing the app so config binds mock mode + a tmp ledger.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-suspended-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;

const SUSPENDED: PublisherConfig = {
  id: "paused",
  originUrl: "http://origin-paused.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: { async resolve() { return undefined; } },
  licenseIdentity: "naulon:paused.example",
  suspended: true,
};

const resolver: PublisherResolver = {
  async resolve(host) {
    return host === "paused.example" ? SUSPENDED : undefined;
  },
};

const app = createApp(resolver);
const realFetch = globalThis.fetch;
let lastTarget = "";
before(() => {
  globalThis.fetch = (async (input: Request | string | URL) => {
    lastTarget = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("a suspended publisher serves a would-be-tolled article free (degraded passthrough), not 402 or 502", async () => {
  const res = await app.request("/essays/anything", {
    headers: { host: "paused.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 200, "an agent that would normally be tolled reads through while suspended");
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /suspended/);
  assert.match(lastTarget, /origin-paused\.local/);
});

test("an unknown host still fails closed (not served) — distinct from suspended", async () => {
  const res = await app.request("/essays/anything", {
    headers: { host: "ghost.example", "x-naulon-agent": "tester" },
  });
  assert.equal(res.status, 502);
});
