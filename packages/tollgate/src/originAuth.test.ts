/**
 * Authenticated origin pull: the gate presents a per-tenant static secret to the
 * origin on every proxied fetch, as `x-naulon-origin-auth: <value>`, so an origin
 * behind its own bot/rate edge recognizes fleet traffic and stops challenging it.
 *
 * Invariants under test (mirrors the proxySsrf harness — no network; assert on the
 * captured outbound headers): the header is sent only when the secret is set AND the
 * origin is https (never leak a bearer over cleartext); a client can never smuggle it
 * (it is in STRIP_HEADERS, so an inbound value is dropped before the gate injects its own).
 */
import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-originauth-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

function pub(originUrl: string, originAuthSecret?: string): PublisherConfig {
  return {
    id: "p",
    originUrl,
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: {
      async resolve(slug: string) {
        return { slug, title: slug, contributors: [{ authorId: "a", wallet: walletAddress("0x0000000000000000000000000000000000000001") }] };
      },
    },
    licenseIdentity: "naulon:p",
    originAuthSecret,
  };
}

let current: PublisherConfig = pub("https://origin.example");
const app = createApp({ async resolve() { return current; } });

const realFetch = globalThis.fetch;
let captured: Headers[] = [];
before(() => {
  // proxyToOrigin calls fetch(target, { headers }) — the outbound headers are the
  // second-arg init, not a Request. Capture them there.
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    captured.push(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]));
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
beforeEach(() => { captured = []; });
after(() => { globalThis.fetch = realFetch; });

test("https origin + secret set → x-naulon-origin-auth header sent with the value", async () => {
  current = pub("https://origin.example", "nlo_testsecret");
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), "nlo_testsecret");
});

test("no secret → header absent", async () => {
  current = pub("https://origin.example", undefined);
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), null);
});

test("http origin + secret set → header absent (cleartext guard)", async () => {
  current = pub("http://origin.local", "nlo_testsecret");
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), null);
});

test("client-supplied x-naulon-origin-auth is stripped, never forwarded", async () => {
  current = pub("https://origin.example", undefined);
  await app.request("/about", { headers: { host: "p.example", "x-naulon-origin-auth": "spoofed" } });
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), null);
});

test("inbound spoof is stripped, the real per-tenant secret wins", async () => {
  current = pub("https://origin.example", "nlo_real");
  await app.request("/about", { headers: { host: "p.example", "x-naulon-origin-auth": "spoofed" } });
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), "nlo_real");
});
