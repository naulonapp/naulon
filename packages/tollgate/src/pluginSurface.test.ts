/**
 * The endpoints an in-app runtime calls (the WordPress plugin, `@naulon/enforce` middleware, the
 * Python package) must be answered by a self-hosted gate, not proxied to the origin. Each path below
 * is one the WordPress plugin's client sends (`plugins/naulon/includes/class-naulon-client.php`).
 *
 * Env is set before importing the app so config binds mock mode and a temporary ledger.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "test-enforce-key-0123456789abcdef0123456789";
process.env.EVENTS_PATH = join(tmpdir(), `naulon-plugin-surface-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = join(tmpdir(), `naulon-plugin-surface-obs-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
process.env.NAULON_ENFORCE_KEY = KEY;

const { createApp } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PUB: PublisherConfig = {
  id: "selfhost",
  originUrl: "http://origin-selfhost.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: { async resolve(slug: string) { return { slug, title: slug, contributors: [{ authorId: "a", wallet: AUTHOR }] }; } },
  licenseIdentity: "naulon:selfhost.example",
};
const app = createApp({ async resolve(host) { return host === "selfhost.example" ? PUB : undefined; } });

const ORIGIN_BODY = "<html>origin</html>";
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => new Response(ORIGIN_BODY, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

const RESOURCE = "https://selfhost.example/essays/piece";
const SURFACE: { method: "GET" | "POST"; path: string; body?: unknown }[] = [
  { method: "GET", path: `/_naulon/enforce-config?resource=${encodeURIComponent(RESOURCE)}` },
  { method: "GET", path: "/_naulon/enforce-status" },
  { method: "GET", path: `/_naulon/quote?resource=${encodeURIComponent(RESOURCE)}&slug=essays/piece&kind=read` },
  { method: "POST", path: "/_naulon/verify", body: {} },
  { method: "POST", path: "/_naulon/license/check", body: {} },
  { method: "POST", path: "/_naulon/observe", body: [] },
];

for (const call of SURFACE) {
  test(`the gate answers ${call.method} ${call.path.split("?")[0]} itself`, async () => {
    const res = await app.request(call.path, {
      method: call.method,
      headers: {
        host: "selfhost.example",
        authorization: `Bearer ${KEY}`,
        ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    });
    const text = await res.text();
    assert.notEqual(text, ORIGIN_BODY, "the request was proxied to the origin instead of answered by the gate");
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });
}

test("an unknown /_naulon/ path still reaches the origin", async () => {
  const res = await app.request("/_naulon/not-an-api-route", { headers: { host: "selfhost.example", authorization: `Bearer ${KEY}` } });
  assert.equal(await res.text(), ORIGIN_BODY);
});

test("the gate serves the OpenAPI document for the API", async () => {
  const res = await app.request("/_naulon/openapi.json", { headers: { host: "selfhost.example" } });
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { openapi: string; info: { version: string }; paths: Record<string, unknown> };
  assert.equal(doc.openapi, "3.1.0");
  for (const p of ["/_naulon/enforce-config", "/_naulon/enforce-status", "/_naulon/quote", "/_naulon/verify", "/_naulon/license/check", "/_naulon/observe"]) {
    assert.ok(doc.paths[p], `${p} is documented`);
  }
});

test("a wrong key is 401 and never proxied", async () => {
  const res = await app.request("/_naulon/enforce-status", { headers: { host: "selfhost.example", authorization: "Bearer wrong" } });
  assert.equal(res.status, 401);
});
