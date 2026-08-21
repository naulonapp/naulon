import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCredentialVerifier,
  hashPassword,
  isHashed,
  parseDashboardAuth,
  parsePhc,
  verifySecret,
} from "./credential.ts";

/** Cheap work factor. The parameters are read back out of the string, so ln=10 exercises the same paths. */
const FAST = { ln: 10, r: 8, p: 1 };

test("a minted hash verifies its own password and rejects every other", async () => {
  const stored = await hashPassword("correct horse battery staple", FAST);
  assert.ok(isHashed(stored));
  assert.equal(await verifySecret(stored, "correct horse battery staple"), true);
  assert.equal(await verifySecret(stored, "correct horse battery stapl"), false);
  assert.equal(await verifySecret(stored, ""), false);
});

test("the hash is salted — the same password minted twice gives different strings", async () => {
  const a = await hashPassword("same", FAST);
  const b = await hashPassword("same", FAST);
  assert.notEqual(a, b);
  assert.equal(await verifySecret(a, "same"), true);
  assert.equal(await verifySecret(b, "same"), true);
});

test("the stored parameters are honoured, not the defaults", async () => {
  const stored = await hashPassword("p", { ln: 11, r: 4, p: 2 });
  const parsed = parsePhc(stored);
  assert.deepEqual(parsed && { ln: parsed.ln, r: parsed.r, p: parsed.p }, { ln: 11, r: 4, p: 2 });
  // Verifying re-derives with THOSE parameters; a default-parameter derive would not match.
  assert.equal(await verifySecret(stored, "p"), true);
});

test("plaintext still verifies — the deprecation window, not a removal", async () => {
  assert.equal(isHashed("hunter2"), false);
  assert.equal(await verifySecret("hunter2", "hunter2"), true);
  assert.equal(await verifySecret("hunter2", "hunter3"), false);
});

test("a secret that LOOKS like a hash but is malformed fails closed, never as plaintext", async () => {
  const broken = "$scrypt$ln=15,r=8,p=1$not-enough-fields";
  assert.equal(parsePhc(broken), null);
  // The dangerous outcome would be true: comparing the PHC text itself as a password.
  assert.equal(await verifySecret(broken, broken), false);
  assert.equal(await verifySecret(broken, "anything"), false);
});

test("parsePhc refuses a work factor a config typo could hang the console with", () => {
  assert.equal(parsePhc("$scrypt$ln=30,r=8,p=1$c2FsdA$aGFzaA"), null);
  assert.equal(parsePhc("$scrypt$ln=0,r=8,p=1$c2FsdA$aGFzaA"), null);
  assert.equal(parsePhc("$scrypt$ln=abc,r=8,p=1$c2FsdA$aGFzaA"), null);
  assert.equal(parsePhc("$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"), null);
});

test("parsePhc refuses a hash of the wrong length", () => {
  // Well-formed envelope, 6-byte digest — not a 32-byte scrypt key.
  assert.equal(parsePhc("$scrypt$ln=10,r=8,p=1$c2FsdHNhbHQ$aGFzaA"), null);
});

test("DASHBOARD_AUTH splits on the FIRST colon, so both forms survive it", async () => {
  const stored = await hashPassword("pw:with:colons", FAST);
  const hashed = parseDashboardAuth(`ops:${stored}`);
  assert.deepEqual(hashed && { username: hashed.username, hashed: hashed.hashed }, { username: "ops", hashed: true });
  assert.equal(hashed && (await verifySecret(hashed.secret, "pw:with:colons")), true);

  const plain = parseDashboardAuth("ops:pw:with:colons");
  assert.deepEqual(plain, { username: "ops", secret: "pw:with:colons", hashed: false });
});

test("an absent or half-written DASHBOARD_AUTH is no credential at all", () => {
  assert.equal(parseDashboardAuth(undefined), null);
  assert.equal(parseDashboardAuth(""), null);
  assert.equal(parseDashboardAuth("ops"), null);
  assert.equal(parseDashboardAuth("ops:"), null);
  assert.equal(parseDashboardAuth(":pw"), null);
});

test("the verifier accepts the right credential and rejects a wrong username", async () => {
  const secret = await hashPassword("s3cret", FAST);
  const verify = createCredentialVerifier({ username: "ops", secret, hashed: true });
  assert.equal(await verify("ops", "s3cret"), true);
  assert.equal(await verify("root", "s3cret"), false);
  assert.equal(await verify("ops", "wrong"), false);
});

test("a verified credential is cached, and the cache expires", async () => {
  let derives = 0;
  const secret = await hashPassword("s3cret", FAST);
  const counted = { username: "ops", get secret() { derives++; return secret; }, hashed: true };
  let clock = 1_000;
  const verify = createCredentialVerifier(counted, { ttlMs: 500, now: () => clock });

  assert.equal(await verify("ops", "s3cret"), true);
  assert.equal(derives, 1);
  assert.equal(await verify("ops", "s3cret"), true);
  assert.equal(derives, 1, "second call inside the TTL must not re-derive");

  clock += 501;
  assert.equal(await verify("ops", "s3cret"), true);
  assert.equal(derives, 2, "after the TTL it re-derives");
});

test("a WRONG credential is never cached — the failed-sign-in budget must keep seeing every guess", async () => {
  let derives = 0;
  const secret = await hashPassword("s3cret", FAST);
  const counted = { username: "ops", get secret() { derives++; return secret; }, hashed: true };
  const verify = createCredentialVerifier(counted, { ttlMs: 60_000 });

  assert.equal(await verify("ops", "guess"), false);
  assert.equal(await verify("ops", "guess"), false);
  assert.equal(derives, 2, "a rejected password must be re-derived, never served from cache");
});

test("the cache is per-credential-pair — one accepted password does not admit another", async () => {
  const secret = await hashPassword("s3cret", FAST);
  const verify = createCredentialVerifier({ username: "ops", secret, hashed: true });
  assert.equal(await verify("ops", "s3cret"), true);
  assert.equal(await verify("ops", "other"), false);
  assert.equal(await verify("other", "s3cret"), false);
});
