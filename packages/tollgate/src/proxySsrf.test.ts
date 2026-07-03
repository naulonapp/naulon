/**
 * The origin proxy must never be coerced off the publisher's own origin. A raw
 * request target beginning `//host`, `/\host`, or `///host` makes
 * `new URL(path, originUrl)` resolve *protocol-relative* and swap the authority —
 * an unauthenticated SSRF / open forward-proxy (e.g. `//169.254.169.254/…` reaches
 * cloud metadata; `//evil.com/…` laundered through the gate). The gate must pin
 * every proxied fetch to the resolved publisher's origin, whatever the target shape.
 */
import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-ssrf-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const ORIGIN = "http://origin.local";
const PUB: PublisherConfig = {
  id: "p",
  originUrl: ORIGIN,
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      return { slug, title: slug, contributors: [{ authorId: "a", wallet: walletAddress("0x0000000000000000000000000000000000000001") }] };
    },
  },
  licenseIdentity: "naulon:p",
};
const app = createApp({ async resolve() { return PUB; } });

const realFetch = globalThis.fetch;
let fetchTargets: string[] = [];
before(() => {
  globalThis.fetch = (async (input: unknown) => {
    fetchTargets.push(input instanceof URL ? input.href : String(input));
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
beforeEach(() => { fetchTargets = []; });
after(() => { globalThis.fetch = realFetch; });

test("a legitimate passthrough proxies to the publisher's own origin", async () => {
  const res = await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(res.status, 200);
  assert.equal(fetchTargets.length, 1);
  assert.equal(new URL(fetchTargets[0]!).host, new URL(ORIGIN).host);
});

// The SSRF vectors: an authority-swapping request target must never be fetched
// off the publisher's origin. Whether the gate refuses or degrades, the one
// invariant is that no proxied fetch leaves the origin host.
for (const target of ["//evil.com/x", "/\\evil.com/x", "///evil.com/x", "//169.254.169.254/latest/meta-data/"]) {
  test(`request target ${JSON.stringify(target)} never proxies off-origin`, async () => {
    const res = await app.request(target, { headers: { host: "p.example" } });
    for (const t of fetchTargets) {
      assert.equal(new URL(t).host, new URL(ORIGIN).host, `proxied off-origin: ${t}`);
    }
    assert.notEqual(res.status, 200, "an off-origin target must not return a proxied 200 body");
  });
}
