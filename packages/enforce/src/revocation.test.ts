/**
 * The revocation seam (default in-memory backend under mock config). A jti is
 * unrevoked until revoked, then stays revoked — the v1 kill switch the online
 * tier and the gate's re-read path consult.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { revocations } from "./revocation.ts";

test("a jti is not revoked until revoked, then is", async () => {
  const jti = "11111111-2222-4333-8444-555555555555";
  assert.equal(await revocations.isRevoked(jti), false);
  await revocations.revoke(jti);
  assert.equal(await revocations.isRevoked(jti), true);
});

test("revoking one jti does not revoke another", async () => {
  await revocations.revoke("aaaa");
  assert.equal(await revocations.isRevoked("bbbb"), false);
});
