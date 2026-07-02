/**
 * Standards-conformance: a CLT must verify with GENERIC JOSE primitives, not just
 * our own verifyLicense. This test re-implements verification from scratch with
 * only node:crypto + a standard JWK import — the exact steps `jose` (Node) and
 * `pyjwt` (Python) perform internally. If this passes, an unmodified third-party
 * JWT library verifies the token too. (Docs ship the jose/pyjwt snippets.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, verify } from "node:crypto";
import { jwksOf, loadSigningKey, mintLicense, type MintInput } from "./license.ts";
import type { AttributedEvent, Usdc, WalletAddress } from "./types.ts";

const KEY = loadSigningKey();
const NOW = 1_700_000_000_000;

const event: AttributedEvent = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  kind: "citation",
  amount: 0.005 as Usdc,
  payees: [{ authorId: "mira", wallet: "0x1111111111111111111111111111111111111111" as WalletAddress, share: 1 }],
  payerAddress: "0x2222222222222222222222222222222222222222" as WalletAddress,
  settlementRef: "ref-1",
  at: NOW,
};
const input: MintInput = {
  event,
  issuer: "naulon:example.com",
  audience: "naulon:example.com",
  ttlSeconds: 600,
  payeesMode: "full",
  title: "On Stillness",
  network: { chainId: 5042002, usdc: "0x36", gateway: "arcTestnet" },
};

test("a minted CLT verifies with generic JOSE primitives (jose/pyjwt parity)", () => {
  const token = mintLicense(input, KEY, NOW);
  const [h, p, s] = token.split(".") as [string, string, string];

  // 1. Resolve the signing key from the published JWK Set by kid — what a
  //    standard verifier does via JWKS.
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg: string; kid: string };
  assert.equal(header.alg, "EdDSA");
  const jwk = jwksOf([KEY]).keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, "kid resolves in JWKS");
  const publicKey = createPublicKey({ key: jwk!, format: "jwk" });

  // 2. Verify the signature over the signing input (header.payload) with Ed25519.
  const ok = verify(null, Buffer.from(`${h}.${p}`, "ascii"), publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true, "signature verifies with a stock Ed25519 verifier");

  // 3. The claims are standard RFC 7519, domain data namespaced under `naulon`.
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(claims.iss, "naulon:example.com");
  assert.equal(claims.aud, "naulon:example.com");
  assert.equal((claims.naulon as { slug: string }).slug, "on-stillness");
});

test("a tampered CLT is rejected by the generic verifier too", () => {
  const token = mintLicense(input, KEY, NOW);
  const [h, p, s] = token.split(".") as [string, string, string];
  const jwk = jwksOf([KEY]).keys[0]!;
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  // Flip a payload character (a signed segment).
  const i = Math.floor(p.length / 2);
  const badP = p.slice(0, i) + (p[i] === "A" ? "B" : "A") + p.slice(i + 1);
  const ok = verify(null, Buffer.from(`${h}.${badP}`, "ascii"), publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, false);
});
