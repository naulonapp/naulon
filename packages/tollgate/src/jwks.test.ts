/**
 * The gate serves its public key set itself — it must never be proxied to the
 * origin (bug checklist #17). Registered before the catch-all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "./app.ts";

test("GET /.well-known/naulon-jwks.json returns an Ed25519 JWK Set, not origin HTML", async () => {
  const res = await app.request("/.well-known/naulon-jwks.json");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { keys: Array<{ kty: string; crv: string; kid: string; alg: string }> };
  assert.ok(Array.isArray(body.keys) && body.keys.length >= 1);
  const jwk = body.keys[0]!;
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.equal(jwk.alg, "EdDSA");
  assert.equal(typeof jwk.kid, "string");
});
