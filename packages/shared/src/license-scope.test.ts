/**
 * W6 — licence scope, term and subject. The claim shape widens; today's single-slug
 * short-window licence stays the default projection, byte-identical when nothing new
 * is supplied.
 *
 * The security line these tests defend: a CITATION RECORD grants nothing. It is
 * permanent precisely because it carries no access right, so anything that could turn
 * one back into a free read is a bypass.
 */
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { test } from "node:test";
import { licenseCoversPath, licenseGrant, type NaulonClaim } from "./license.ts";

const base: NaulonClaim = {
  v: 1,
  slug: "on-stillness",
  title: "On Stillness",
  kind: "citation",
  amount: "5000",
  currency: "USDC",
  network: { chainId: 5042002, usdc: "0x36", gateway: "arcTestnet" },
  settlementRef: "mock-ref-1",
};

// ── grant ────────────────────────────────────────────────────────────────────

test("an absent grant reads as 'read' — today's licence is unchanged", () => {
  assert.equal(licenseGrant(base), "read");
});

test("a citation record grants nothing", () => {
  assert.equal(licenseGrant({ ...base, grant: "none" }), "none");
});

test("an unknown grant is refused as 'none', never read as access", () => {
  // Fail closed: a future grant kind this build does not understand must not
  // entitle a read on an old deployment.
  assert.equal(licenseGrant({ ...base, grant: "future-kind" as never }), "none");
});

// ── scope ────────────────────────────────────────────────────────────────────

test("no scope: the licence covers exactly its own slug", () => {
  assert.equal(licenseCoversPath(base, { slug: "on-stillness", path: "/essays/on-stillness" }), true);
  assert.equal(licenseCoversPath(base, { slug: "on-motion", path: "/essays/on-motion" }), false);
});

test("a scoped licence matches the request PATH, not the slug", () => {
  // Prefix mode's slug is the captured segment ("on-stillness"), not a path, so a
  // path pattern can only ever be matched against the path.
  const scoped: NaulonClaim = { ...base, scope: { patterns: ["/essays/*"] } };
  assert.equal(licenseCoversPath(scoped, { slug: "anything", path: "/essays/on-stillness" }), true);
  assert.equal(licenseCoversPath(scoped, { slug: "anything", path: "/notes/on-stillness" }), false);
});

test("scope uses RFC 9309, where `*` crosses path segments", () => {
  const scoped: NaulonClaim = { ...base, scope: { patterns: ["/essays/*"] } };
  assert.equal(licenseCoversPath(scoped, { slug: "x", path: "/essays/2026/deep/nested" }), true);
});

test("a trailing $ anchors the end of the path", () => {
  const scoped: NaulonClaim = { ...base, scope: { patterns: ["/paper.pdf$"] } };
  assert.equal(licenseCoversPath(scoped, { slug: "x", path: "/paper.pdf" }), true);
  assert.equal(licenseCoversPath(scoped, { slug: "x", path: "/paper.pdf.bak" }), false);
});

test("any one pattern in the scope is enough", () => {
  const scoped: NaulonClaim = { ...base, scope: { patterns: ["/a/*", "/b/*"] } };
  assert.equal(licenseCoversPath(scoped, { slug: "x", path: "/b/thing" }), true);
});

test("an empty pattern list covers nothing — it is not a wildcard", () => {
  const scoped: NaulonClaim = { ...base, scope: { patterns: [] } };
  assert.equal(licenseCoversPath(scoped, { slug: "on-stillness", path: "/essays/on-stillness" }), false);
});

test("an empty-string pattern covers nothing — RSL's association scope is not ours to resolve", () => {
  const scoped: NaulonClaim = { ...base, scope: { patterns: [""] } };
  assert.equal(licenseCoversPath(scoped, { slug: "x", path: "/anything" }), false);
});

test("a non-array scope from a malformed token covers nothing", () => {
  const junk = { ...base, scope: { patterns: "/essays/*" } } as unknown as NaulonClaim;
  assert.equal(licenseCoversPath(junk, { slug: "on-stillness", path: "/essays/on-stillness" }), false);
});

test("a scoped licence does NOT fall back to slug equality", () => {
  // Otherwise a scope that fails to match would silently widen to the mint-time slug.
  const scoped: NaulonClaim = { ...base, scope: { patterns: ["/essays/*"] } };
  assert.equal(licenseCoversPath(scoped, { slug: "on-stillness", path: "/notes/x" }), false);
});

// ── mint: the default projection is untouched ────────────────────────────────

import {
  jwksOf,
  loadSigningKey,
  mintCitationRecord,
  mintLicense,
  verifyLicense,
  type JwkSet,
  type MintInput,
  type SigningKey,
} from "./license.ts";
import type { AttributedEvent, AuthorShare, Usdc, WalletAddress } from "./types.ts";

const KEY: SigningKey = loadSigningKey();
const JWKS: JwkSet = jwksOf([KEY]);
const ISS = "naulon:test.example";
const NOW = 1_700_000_000_000;
const payees: AuthorShare[] = [
  { authorId: "mira", wallet: "0x1111111111111111111111111111111111111111" as WalletAddress, share: 1 },
];
const event: AttributedEvent = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  kind: "citation",
  amount: 0.005 as Usdc,
  payees,
  payerAddress: "0x3333333333333333333333333333333333333333" as WalletAddress,
  settlementRef: "mock-ref-1",
  at: NOW,
};
const mintInput: MintInput = {
  event,
  issuer: ISS,
  audience: ISS,
  ttlSeconds: 600,
  payeesMode: "full",
  title: "On Stillness",
  network: { chainId: 5042002, usdc: "0x36", gateway: "arcTestnet" },
};
const verifyOpts = { now: NOW, expectedIssuer: ISS, expectedAudience: ISS, jwks: JWKS };
function payloadOf(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("an unwidened mint emits none of the new claim fields", () => {
  const naulon = payloadOf(mintLicense(mintInput, KEY, NOW))["naulon"] as Record<string, unknown>;
  for (const k of ["grant", "scope", "terms", "period"]) {
    assert.equal(k in naulon, false, `${k} must be absent on today's licence`);
  }
});

test("sub still defaults to the payer wallet", () => {
  assert.equal(payloadOf(mintLicense(mintInput, KEY, NOW))["sub"], event.payerAddress);
});

test("an explicit subject replaces the payer wallet as `sub`", () => {
  const jws = mintLicense({ ...mintInput, subject: "acct:library-7" }, KEY, NOW);
  assert.equal(payloadOf(jws)["sub"], "acct:library-7");
});

test("mint carries scope, terms and period through to the claim", () => {
  const jws = mintLicense(
    {
      ...mintInput,
      scope: { patterns: ["/essays/*"] },
      terms: ["ai-input", "ai-index"],
      period: { from: 1_700_000_000, until: 1_702_592_000 },
    },
    KEY,
    NOW,
  );
  const naulon = payloadOf(jws)["naulon"] as Record<string, unknown>;
  assert.deepEqual(naulon["scope"], { patterns: ["/essays/*"] });
  assert.deepEqual(naulon["terms"], ["ai-input", "ai-index"]);
  assert.deepEqual(naulon["period"], { from: 1_700_000_000, until: 1_702_592_000 });
});

test("a minted access licence still verifies and still grants read", () => {
  const r = verifyLicense(mintLicense({ ...mintInput, scope: { patterns: ["/essays/*"] } }, KEY, NOW), verifyOpts);
  assert.equal(r.ok, true);
  assert.equal(licenseGrant((r as { ok: true; claims: { naulon: NaulonClaim } }).claims.naulon), "read");
});

// ── the citation record ──────────────────────────────────────────────────────

test("a citation record grants nothing and never expires", () => {
  const naulon = payloadOf(mintCitationRecord(mintInput, KEY, NOW))["naulon"] as Record<string, unknown>;
  assert.equal(naulon["grant"], "none");
  assert.equal("exp" in payloadOf(mintCitationRecord(mintInput, KEY, NOW)), false);
});

test("a record verifies a century later — permanence is the product", () => {
  const jws = mintCitationRecord(mintInput, KEY, NOW);
  const r = verifyLicense(jws, { ...verifyOpts, now: NOW + 100 * 365 * 24 * 3600 * 1000 });
  assert.equal(r.ok, true);
});

test("a record still records who paid, what, and how it settled", () => {
  const claims = payloadOf(mintCitationRecord({ ...mintInput, subject: "acct:library-7" }, KEY, NOW));
  const naulon = claims["naulon"] as Record<string, unknown>;
  assert.equal(claims["sub"], "acct:library-7");
  assert.equal(claims["jti"], event.id);
  assert.equal(naulon["amount"], "5000");
  assert.equal(naulon["settlementRef"], "mock-ref-1");
  assert.deepEqual(naulon["payees"], [{ authorId: "mira", wallet: payees[0]!.wallet, share: 1 }]);
});

test("a record is not yet valid before its nbf", () => {
  const r = verifyLicense(mintCitationRecord(mintInput, KEY, NOW), { ...verifyOpts, now: NOW - 120_000 });
  assert.equal(r.ok, false);
});

// ── the bypass this whole split exists to prevent ────────────────────────────

/** Sign a payload with the real key, so a refusal is the RULE refusing — not a bad signature. */
function signed(payload: Record<string, unknown>): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: KEY.kid };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), KEY.privateKey).toString("base64url")}`;
}

test("a validly signed ACCESS licence with no exp is refused — expiry is its kill switch", () => {
  const claims = payloadOf(mintLicense(mintInput, KEY, NOW));
  delete claims["exp"];
  const r = verifyLicense(signed(claims), verifyOpts);
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; error: string }).error, /exp/i);
});

test("the SAME payload verifies once its grant says it entitles nothing", () => {
  // Isolates the rule to the grant: identical claims, only `naulon.grant` differs.
  const claims = payloadOf(mintLicense(mintInput, KEY, NOW));
  delete claims["exp"];
  (claims["naulon"] as Record<string, unknown>)["grant"] = "none";
  assert.equal(verifyLicense(signed(claims), verifyOpts).ok, true);
});

test("an unrecognised grant with no exp is refused — unknown is not a record", () => {
  const claims = payloadOf(mintLicense(mintInput, KEY, NOW));
  delete claims["exp"];
  (claims["naulon"] as Record<string, unknown>)["grant"] = "someday";
  assert.equal(verifyLicense(signed(claims), verifyOpts).ok, false);
});

test("mintCitationRecord always stamps grant 'none', whatever it is handed", () => {
  const naulon = payloadOf(
    mintCitationRecord({ ...mintInput, scope: { patterns: ["/*"] }, terms: ["ai-input"] }, KEY, NOW),
  )["naulon"] as Record<string, unknown>;
  assert.equal(naulon["grant"], "none");
});
