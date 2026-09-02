/**
 * The JWKS must be readable FROM A BROWSER.
 *
 * The whole claim behind a Citation License is that a stranger can verify it against
 * published keys without asking naulon. Our own published skill tells people to do it
 * with `jose`'s `createRemoteJWKSet` — which works from Node and is blocked in a browser
 * by the same-origin policy unless this endpoint says otherwise. Measured on the prod
 * gate 2026-09-02: no `access-control-allow-origin` header at all, so every browser-based
 * verifier (including naulon's own public verify page) fails at the fetch.
 *
 * A public key set is world-readable by definition. `*` is the correct value: anything
 * narrower would decide FOR third parties which origins may check our signatures, which
 * is the opposite of the property being sold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.EVENTS_PATH ??= "/tmp/naulon-jwks-cors-test.jsonl";
process.env.PAYMENT_MODE ??= "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";
const { app } = await import("./app.ts");

const JWKS = "/.well-known/naulon-jwks.json";

test("the JWKS is fetchable cross-origin", async () => {
  const res = await app.request(JWKS, { headers: { origin: "https://naulon.app" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("it answers a browser's preflight", async () => {
  const res = await app.request(JWKS, {
    method: "OPTIONS",
    headers: { origin: "https://example.test", "access-control-request-method": "GET" },
  });
  assert.ok(res.status === 200 || res.status === 204, `preflight must not fail: got ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("it is still the key set, and still cacheable by anyone", async () => {
  const res = await app.request(JWKS);
  const body = (await res.json()) as { keys: Array<{ kty: string; kid: string }> };
  assert.ok(Array.isArray(body.keys));
  assert.equal(body.keys[0]?.kty, "OKP");
});

test("CORS is scoped to the key set — a tolled path does not become cross-origin readable", async () => {
  // The gate's whole job is refusing cross-origin readers who have not paid; opening the
  // JWKS must not open anything else.
  const res = await app.request("/essays/on-stillness", {
    headers: { origin: "https://naulon.app", "user-agent": "GPTBot/1.0" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
