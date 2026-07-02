/**
 * Adversarial CLT suite — these are the tests that actually matter (the forgery
 * surfaces a hand-rolled JWS verifier must close). Each maps to the bug checklist
 * in docs/citation-license.md.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import {
  jwksOf,
  loadSigningKey,
  mintLicense,
  popBoundAddress,
  popMessage,
  verifyLicense,
  type CitationLicenseClaims,
  type JwkSet,
  type MintInput,
  type SigningKey,
} from "./license.ts";
import type { AttributedEvent, AuthorShare, Usdc, WalletAddress } from "./types.ts";

const KEY: SigningKey = loadSigningKey(); // ephemeral is fine for tests
const JWKS: JwkSet = jwksOf([KEY]);
const ISS = "naulon:test.example";
const AUD = "naulon:test.example";
const NETWORK = { chainId: 5042002, usdc: "0x3600000000000000000000000000000000000000", gateway: "arcTestnet" };

const payees: AuthorShare[] = [
  { authorId: "mira", wallet: "0x1111111111111111111111111111111111111111" as WalletAddress, share: 0.7 },
  { authorId: "ito", wallet: "0x2222222222222222222222222222222222222222" as WalletAddress, share: 0.3 },
];
const event: AttributedEvent = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  kind: "citation",
  amount: 0.005 as Usdc,
  payees,
  payerAddress: "0x3333333333333333333333333333333333333333" as WalletAddress,
  settlementRef: "mock-ref-1",
  at: 1_700_000_000_000,
};
const mintInput: MintInput = {
  event,
  issuer: ISS,
  audience: AUD,
  ttlSeconds: 600,
  payeesMode: "full",
  title: "On Stillness",
  network: NETWORK,
};
const NOW = 1_700_000_000_000; // ms
const verifyOpts = { now: NOW, expectedIssuer: ISS, expectedAudience: AUD, jwks: JWKS };

function decodePart(jws: string, i: number): Record<string, unknown> {
  const seg = jws.split(".")[i]!;
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}
function b64urlJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

test("mint → verify round-trip returns the claims, offline, no network", () => {
  const jws = mintLicense(mintInput, KEY, NOW);
  const r = verifyLicense(jws, verifyOpts);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.claims.naulon.slug === "on-stillness");
  assert.ok(r.ok && r.claims.naulon.amount === "5000"); // micro-USDC integer string
  assert.ok(r.ok && r.claims.naulon.payees?.length === 2);
  assert.ok(r.ok && r.claims.jti === event.id);
});

test("alg:none is rejected", () => {
  const header = b64urlJson({ alg: "none", typ: "JWT", kid: KEY.kid });
  const body = b64urlJson({ iss: ISS, aud: AUD, exp: 9_999_999_999 });
  // Non-empty sig segment so the token reaches (and is killed by) the alg pin,
  // not the earlier empty-segment check.
  const r = verifyLicense(`${header}.${body}.AA`, verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /alg/);
});

test("HS256 signed with the published public key is rejected (alg confusion)", () => {
  const pubX = JWKS.keys[0]!.x; // the world-readable public key bytes
  const header = b64urlJson({ alg: "HS256", typ: "JWT", kid: KEY.kid });
  const body = b64urlJson({ iss: ISS, aud: AUD, exp: 9_999_999_999, naulon: { slug: "x" } });
  const signingInput = `${header}.${body}`;
  const forged = createHmac("sha256", Buffer.from(pubX, "base64url")).update(signingInput).digest("base64url");
  const r = verifyLicense(`${signingInput}.${forged}`, verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /alg/);
});

test("a forbidden header param (crit) is rejected", () => {
  const header = b64urlJson({ alg: "EdDSA", typ: "JWT", kid: KEY.kid, crit: ["exp"] });
  const body = b64urlJson({ iss: ISS, aud: AUD, exp: 9_999_999_999 });
  const r = verifyLicense(`${header}.${body}.AA`, verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /forbidden/);
});

test("an oversized token is rejected before parsing", () => {
  const r = verifyLicense("a.".repeat(3000), verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /too large/);
});

test("wrong segment count and non-base64url segments are rejected", () => {
  assert.equal(verifyLicense("only.two", verifyOpts).ok, false);
  assert.equal(verifyLicense("a.b.c.d", verifyOpts).ok, false);
  assert.equal(verifyLicense("not base64!.b.c", verifyOpts).ok, false);
});

test("a re-serialized payload with the same JSON but different bytes fails (literal-byte verify)", () => {
  const jws = mintLicense(mintInput, KEY, NOW);
  const [h, , s] = jws.split(".") as [string, string, string];
  const claims = decodePart(jws, 1);
  const reserialized = Buffer.from(JSON.stringify(claims, null, 2), "utf8").toString("base64url"); // pretty != compact
  const r = verifyLicense(`${h}.${reserialized}.${s}`, verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signature/);
});

test("a one-character tamper in the payload fails the signature", () => {
  const jws = mintLicense(mintInput, KEY, NOW);
  const [h, p, s] = jws.split(".") as [string, string, string];
  // Flip a char inside the payload (a signed segment) — not the sig's trailing
  // padding bits, which can be a no-op on a 64-byte Ed25519 signature.
  const i = Math.floor(p.length / 2);
  const flipped = p.slice(0, i) + (p[i] === "A" ? "B" : "A") + p.slice(i + 1);
  assert.equal(verifyLicense(`${h}.${flipped}.${s}`, verifyOpts).ok, false);
});

test("issuer and audience mismatch are rejected", () => {
  const jws = mintLicense(mintInput, KEY, NOW);
  assert.match(
    (verifyLicense(jws, { ...verifyOpts, expectedIssuer: "naulon:other" }) as { error: string }).error,
    /issuer/,
  );
  assert.match(
    (verifyLicense(jws, { ...verifyOpts, expectedAudience: "naulon:other" }) as { error: string }).error,
    /audience/,
  );
});

test("expiry boundary uses >= (now==exp is expired; now==exp-1 is valid)", () => {
  const jws = mintLicense(mintInput, KEY, NOW); // iat = NOW/1000, exp = iat+600
  const iat = Math.floor(NOW / 1000);
  const expMs = (iat + 600) * 1000;
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: expMs }).ok, false); // == exp -> expired
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: expMs - 1000 }).ok, true); // exp-1s -> valid
});

test("claims are epoch seconds, compared against floor(now/1000) — no 1000x bug", () => {
  const jws = mintLicense(mintInput, KEY, NOW);
  // Valid right at mint and one second before TTL end; invalid one ms past exp.
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: NOW }).ok, true);
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: NOW + 599_000 }).ok, true);
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: NOW + 600_000 }).ok, false);
});

test("a token issued in the future (beyond skew) is rejected", () => {
  const future = NOW + 10 * 60 * 1000; // minted 10 min ahead
  const jws = mintLicense(mintInput, KEY, future);
  assert.equal(verifyLicense(jws, { ...verifyOpts, now: NOW }).ok, false);
});

test("an unknown kid is rejected", () => {
  const other = jwksOf([loadSigningKey()]); // different ephemeral key
  const jws = mintLicense(mintInput, KEY, NOW);
  const r = verifyLicense(jws, { ...verifyOpts, jwks: other });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /kid not in JWKS/);
});

test("a token signed by a different key fails the signature even if its kid is advertised", () => {
  const attacker = loadSigningKey();
  // Advertise the attacker's kid in JWKS but under the real key's bytes? No —
  // verify resolves by kid, so a token with the real kid signed by the attacker
  // key must fail against the real JWKS.
  const forged = mintLicense({ ...mintInput }, { ...attacker, kid: KEY.kid }, NOW);
  const r = verifyLicense(forged, verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signature/);
});

test("hashed payees mode embeds a hash + primary payTo, not the full graph", () => {
  const jws = mintLicense({ ...mintInput, payeesMode: "hashed" }, KEY, NOW);
  const r = verifyLicense(jws, verifyOpts);
  assert.ok(r.ok);
  assert.ok(r.ok && typeof r.claims.naulon.payeesHash === "string");
  assert.ok(r.ok && r.claims.naulon.payTo === payees[0]!.wallet); // 0.7 share = primary
  assert.ok(r.ok && r.claims.naulon.payees === undefined);
});

test("mint is deterministic for a fixed key, event and now (Ed25519/RFC8032)", () => {
  assert.equal(mintLicense(mintInput, KEY, NOW), mintLicense(mintInput, KEY, NOW));
});

test("mint reads only the in-memory event (no sink, no I/O)", () => {
  // If mint touched a store it would need creds/network; it must not. A bare
  // event object is sufficient.
  const jws = mintLicense(mintInput, KEY, NOW);
  assert.equal(typeof jws, "string");
  assert.equal(jws.split(".").length, 3);
});

// ── Holder-of-key (P5) ──────────────────────────────────────────────────────

test("mint without popBindAddress carries NO cnf claim (v1 bearer)", () => {
  const claims = decodePart(mintLicense(mintInput, KEY, NOW), 1);
  assert.equal("cnf" in claims, false);
});

test("mint with popBindAddress binds a lowercased cnf:naulon:addr", () => {
  const jws = mintLicense(
    { ...mintInput, popBindAddress: "0xAbCDef0000000000000000000000000000000001" },
    KEY,
    NOW,
  );
  const claims = decodePart(jws, 1) as unknown as CitationLicenseClaims;
  assert.equal(claims.cnf?.["naulon:addr"], "0xabcdef0000000000000000000000000000000001");
  // The bound license still verifies as a normal CLT (cnf is additive).
  assert.ok(verifyLicense(jws, verifyOpts).ok);
});

test("popBoundAddress reads the binding, lowercased, or null", () => {
  const bound = { cnf: { "naulon:addr": "0xABC" } } as unknown as CitationLicenseClaims;
  assert.equal(popBoundAddress(bound), "0xabc");
  assert.equal(popBoundAddress({} as CitationLicenseClaims), null);
});

test("popMessage is deterministic and binds every field in a fixed framing", () => {
  const c = { aud: "naulon:g", jti: "j1", slug: "on-stillness", ts: 1700, nonce: "ab12" };
  const m = popMessage(c);
  assert.equal(m, popMessage({ ...c })); // deterministic
  assert.equal(
    m,
    "naulon-pop\nv=1\naud=naulon:g\njti=j1\nslug=on-stillness\nts=1700\nnonce=ab12",
  );
  // Any field change changes the bytes (so a proof can't be cross-bound).
  assert.notEqual(m, popMessage({ ...c, slug: "other" }));
  assert.notEqual(m, popMessage({ ...c, aud: "naulon:other" }));
  assert.notEqual(m, popMessage({ ...c, jti: "j2" }));
});
