/**
 * Holder-of-key proof verification (P5). The wallet signs popMessage(...) over a
 * fresh challenge; the gate recovers the signer and accepts only a fresh,
 * single-use proof from the bound wallet. Fails closed on every other input.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { popMessage, type CitationLicenseClaims } from "@naulon/shared";

process.env.NONCE_BACKEND = "memory";
process.env.LICENSE_POP_WINDOW_SECONDS = "120";

const { verifyPopProof } = await import("./pop.ts");

// A throwaway, deterministic test wallet — derived, never a hardcoded key literal.
import { createHash, randomBytes } from "node:crypto";
const ACCOUNT = privateKeyToAccount(`0x${createHash("sha256").update("naulon-pop-test").digest("hex")}`);
const IDENTITY = "naulon:gate.test";
const SLUG = "on-stillness";
const NOW = 1_700_000_000_000; // ms
const NOW_SEC = Math.floor(NOW / 1000);

function boundClaims(jti = "jti-1", addr = ACCOUNT.address): CitationLicenseClaims {
  return { jti, cnf: { "naulon:addr": addr } } as unknown as CitationLicenseClaims;
}

/** Sign a proof header `<ts>.<nonce>.<sig>` as a holder would. */
async function makeProof(opts: {
  aud?: string;
  jti?: string;
  slug?: string;
  ts?: number;
  nonce?: string;
  account?: ReturnType<typeof privateKeyToAccount>;
}): Promise<string> {
  const aud = opts.aud ?? IDENTITY;
  const jti = opts.jti ?? "jti-1";
  const slug = opts.slug ?? SLUG;
  const ts = opts.ts ?? NOW_SEC;
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  const account = opts.account ?? ACCOUNT;
  const sig = await account.signMessage({ message: popMessage({ aud, jti, slug, ts, nonce }) });
  return `${ts}.${nonce}.${sig}`;
}

const ctx = (claims = boundClaims()) => ({ claims, slug: SLUG, identity: IDENTITY, now: NOW });

test("a fresh proof signed by the bound wallet is accepted", async () => {
  const proof = await makeProof({});
  assert.equal(await verifyPopProof(proof, ctx()), true);
});

test("a proof signed by a DIFFERENT wallet is rejected", async () => {
  const other = privateKeyToAccount(`0x${createHash("sha256").update("attacker").digest("hex")}`);
  const proof = await makeProof({ account: other });
  assert.equal(await verifyPopProof(proof, ctx()), false);
});

test("a stale proof (ts older than the window) is rejected", async () => {
  const proof = await makeProof({ ts: NOW_SEC - 121 });
  assert.equal(await verifyPopProof(proof, ctx()), false);
});

test("a future-dated proof (beyond the window) is rejected", async () => {
  const proof = await makeProof({ ts: NOW_SEC + 121 });
  assert.equal(await verifyPopProof(proof, ctx()), false);
});

test("a proof is single-use — the same nonce cannot be replayed", async () => {
  const nonce = "a".repeat(32);
  const proof = await makeProof({ nonce });
  assert.equal(await verifyPopProof(proof, ctx()), true);
  assert.equal(await verifyPopProof(proof, ctx()), false); // replay
});

test("a proof bound to a different gate (aud) is rejected", async () => {
  // Holder signs for another deployment; this gate reconstructs with its own aud,
  // so the recovered signer won't match the signature.
  const proof = await makeProof({ aud: "naulon:other.gate" });
  assert.equal(await verifyPopProof(proof, ctx()), false);
});

test("a proof bound to a different slug is rejected", async () => {
  const proof = await makeProof({ slug: "some-other-essay" });
  assert.equal(await verifyPopProof(proof, ctx()), false);
});

test("a proof for a different jti is rejected (the gate uses the license jti)", async () => {
  const proof = await makeProof({ jti: "jti-OTHER" });
  assert.equal(await verifyPopProof(proof, ctx(boundClaims("jti-1"))), false);
});

test("a license with no cnf binding is rejected (not a holder-of-key license)", async () => {
  const proof = await makeProof({});
  const noCnf = { jti: "jti-1" } as unknown as CitationLicenseClaims;
  assert.equal(await verifyPopProof(proof, ctx(noCnf)), false);
});

test("malformed, oversized, and wrong-shape proofs fail closed", async () => {
  assert.equal(await verifyPopProof("", ctx()), false);
  assert.equal(await verifyPopProof("x".repeat(2000), ctx()), false);
  assert.equal(await verifyPopProof("only.two", ctx()), false);
  assert.equal(await verifyPopProof(`${NOW_SEC}.badnonce!.0xdead`, ctx()), false);
  assert.equal(await verifyPopProof(`${NOW_SEC}.${"a".repeat(32)}.0xnotasig`, ctx()), false);
});
