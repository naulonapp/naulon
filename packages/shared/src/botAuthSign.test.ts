/**
 * Web Bot Auth signing side — key derivation from a seed, header shapes, and
 * the directory body. The byte-level interop proof (our signer against our
 * verifier) lives gate-side in tollgate/botAuthSign.roundtrip.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  botAuthDirectoryBody,
  botAuthKeyFromSeed,
  botAuthThumbprint,
  signBotAuth,
  signBotAuthDirectory,
} from "./botAuthSign.ts";

// Any fixed 32 bytes make a valid Ed25519 seed; derivation must be stable.
const SEED = Buffer.alloc(32, 7).toString("base64url");

test("botAuthKeyFromSeed derives a stable public key + RFC 7638 thumbprint", () => {
  const a = botAuthKeyFromSeed(SEED);
  const b = botAuthKeyFromSeed(SEED);
  assert.equal(a.x, b.x);
  assert.equal(a.keyid, b.keyid);
  assert.equal(a.keyid, botAuthThumbprint(a.x));
  // base64url, no padding — the JWK x of a 32-byte Ed25519 point is 43 chars.
  assert.equal(a.x.length, 43);
});

test("botAuthKeyFromSeed fails loud on a malformed seed", () => {
  assert.throws(() => botAuthKeyFromSeed("dG9vLXNob3J0"), /32-byte/);
  assert.throws(() => botAuthKeyFromSeed(""), /32-byte/);
});

test("signBotAuth emits the three headers in the CF operational profile shape", () => {
  const key = botAuthKeyFromSeed(SEED);
  const h = signBotAuth({
    key,
    authority: "Gate.Example",
    tag: "web-bot-auth",
    agent: "signer.example",
    createdSec: 1_700_000_000,
    validitySec: 60,
  });
  assert.equal(
    h["signature-input"],
    `sig1=("@authority");created=1700000000;expires=1700000060;keyid="${key.keyid}";tag="web-bot-auth"`,
  );
  assert.match(h.signature, /^sig1=:[A-Za-z0-9+/]+=*:$/);
  // Plain quoted string — CF rejects the rev-00 dictionary form.
  assert.equal(h["signature-agent"], '"signer.example"');

  // The signature verifies over the base the verifier will rebuild
  // (@authority lowercased + the verbatim member text).
  const member = h["signature-input"].slice("sig1=".length);
  const base = `"@authority": gate.example\n"@signature-params": ${member}`;
  const sig = Buffer.from(h.signature.slice("sig1=:".length, -1), "base64");
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
  assert.ok(cryptoVerify(null, Buffer.from(base, "utf8"), pub, sig));
});

test("directory body is a minimal Ed25519 JWKS; directory signature omits Signature-Agent", () => {
  const key = botAuthKeyFromSeed(SEED);
  const body = JSON.parse(botAuthDirectoryBody(key)) as { keys: Array<{ kty: string; crv: string; x: string }> };
  assert.deepEqual(body, { keys: [{ kty: "OKP", crv: "Ed25519", x: key.x }] });

  const h = signBotAuthDirectory(key, "naulon.app");
  assert.match(h["signature-input"], /tag="http-message-signatures-directory"/);
  assert.equal(h["signature-agent"], undefined);
});
