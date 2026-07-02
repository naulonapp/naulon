import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeNonce, issueNonce, type NonceBinding } from "./nonce.ts";

const binding: NonceBinding = {
  amount: "1000",
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:5042002",
};

test("a freshly issued nonce is accepted once", async () => {
  const now = 1_000_000;
  const nonce = issueNonce(binding, now);
  assert.deepEqual(await consumeNonce(nonce, binding, now), { ok: true });
});

test("replay is rejected", async () => {
  const now = 1_000_000;
  const nonce = issueNonce(binding, now);
  assert.equal((await consumeNonce(nonce, binding, now)).ok, true);
  const second = await consumeNonce(nonce, binding, now);
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /replay/);
});

test("an expired nonce is rejected", async () => {
  const issuedAt = 0;
  const nonce = issueNonce(binding, issuedAt);
  // default TTL is 300s; well past it
  const result = await consumeNonce(nonce, binding, issuedAt + 301_000);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /expired/);
});

test("a nonce minted for one binding can't satisfy another (price swap)", async () => {
  const now = 2_000_000;
  const cheap = issueNonce(binding, now);
  const pricier: NonceBinding = { ...binding, amount: "5000" };
  const result = await consumeNonce(cheap, pricier, now);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /signature/);
});

test("a tampered nonce is rejected", async () => {
  const now = 3_000_000;
  const nonce = issueNonce(binding, now);
  const tampered = nonce.slice(0, -1) + (nonce.endsWith("a") ? "b" : "a");
  assert.equal((await consumeNonce(tampered, binding, now)).ok, false);
});

test("a malformed nonce is rejected, not thrown", async () => {
  assert.equal((await consumeNonce("not-a-nonce", binding, 0)).ok, false);
});
