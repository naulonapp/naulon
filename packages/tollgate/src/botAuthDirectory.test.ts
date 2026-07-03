/**
 * The gate serves OUR Web Bot Auth key directory (WBA slice 3) — registered
 * before the catch-all like the JWKS route, never tolled or proxied, and the
 * response is itself signed (tag="http-message-signatures-directory") so a
 * verifier can bind the published keys to this host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const SEED = Buffer.alloc(32, 3).toString("base64url");
process.env.BOT_AUTH_SIGNING_KEY = SEED;
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildSignatureBase, parseSignatureInput, parseSignatureHeader, verifyEd25519, jwkThumbprint } = await import(
  "./botAuth.ts"
);
const { botAuthKeyFromSeed } = await import("@naulon/shared");

const PATH = "/.well-known/http-message-signatures-directory";

test("the directory serves our Ed25519 JWKS with the registered content type and a valid self-signature", async () => {
  const app = createApp();
  const res = await app.request(PATH, { headers: { host: "gate.naulon.app" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/http-message-signatures-directory+json");

  const key = botAuthKeyFromSeed(SEED);
  const body = (await res.json()) as { keys: Array<{ kty: string; crv: string; x: string }> };
  assert.deepEqual(body.keys, [{ kty: "OKP", crv: "Ed25519", x: key.x }]);

  // Verify the response signature exactly as a fetching verifier would.
  const entries = parseSignatureInput(res.headers.get("signature-input") ?? "");
  const entry = entries?.find((e) => e.params.tag === "http-message-signatures-directory");
  assert.ok(entry, "response carries a directory-tagged signature");
  assert.equal(entry.params.keyid, jwkThumbprint(key.x));
  const sig = parseSignatureHeader(res.headers.get("signature") ?? "")?.get(entry.label);
  assert.ok(sig);
  const base = buildSignatureBase(entry, {
    authority: "gate.naulon.app",
    method: "GET",
    path: PATH,
    targetUri: `https://gate.naulon.app${PATH}`,
    headers: {},
  });
  assert.ok(base !== null);
  assert.ok(verifyEd25519(base, sig, key.x), "directory self-signature verifies");
});
