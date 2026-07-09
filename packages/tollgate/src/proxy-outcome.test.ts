/**
 * `onUpstreamOutcome` is the gate's optional telemetry seam: after every
 * upstream fetch, `createApp` fires it with the resolved status and the
 * first-present mitigation marker header (`x-vercel-mitigated` /
 * `cf-mitigated`). Advisory only — a downstream host (e.g. a multi-tenant
 * control plane) can observe throttle/mitigation signals without the gate
 * itself knowing why they matter. The gate does nothing with it; existing
 * `createApp()` callers that omit the option are byte-identical to before.
 *
 * Env is set BEFORE importing the app so config binds mock mode + a tmp
 * ledger, matching the convention in suspended.test.ts / proxySsrf.test.ts.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-proxy-outcome-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;

/**
 * Mirrors the resolver fakes in suspended.test.ts / proxySsrf.test.ts: answers
 * one host with a publisher config. The credits resolver returns undefined for
 * every slug — the gate's own "unknown article, don't gate" passthrough — so
 * the request reaches `proxyToOrigin` without needing a payment flow.
 */
function stubResolverForHost(host: string, originUrl: string, publisherId: string): PublisherResolver {
  const PUB: PublisherConfig = {
    id: publisherId,
    originUrl,
    articlePrefixes: ["some"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: { async resolve() { return undefined; } },
    licenseIdentity: `naulon:${publisherId}`,
  };
  return {
    async resolve(h: string) {
      return h === host ? PUB : undefined;
    },
  };
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

test("onUpstreamOutcome fires with upstream status + mitigation marker", async () => {
  const seen: Array<{ id: string; status: number; marker?: string }> = [];
  // A resolver that answers one host with an origin we stub via global fetch.
  const resolver = stubResolverForHost("pub.example", "https://origin.example", "pub-1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("throttled", { status: 429, headers: { "x-vercel-mitigated": "rate_limit" } });
  try {
    const app = createApp(resolver, { onUpstreamOutcome: (id, o) => seen.push({ id, ...o }) });
    await app.request("https://pub.example/some/article", { headers: { "user-agent": "GPTBot" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [{ id: "pub-1", status: 429, marker: "x-vercel-mitigated" }]);
});

test("onUpstreamOutcome is optional — createApp() without it is unaffected", async () => {
  const resolver = stubResolverForHost("pub2.example", "https://origin2.example", "pub-2");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const app = createApp(resolver);
    const res = await app.request("https://pub2.example/some/article", {
      headers: { "user-agent": "GPTBot" },
    });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
