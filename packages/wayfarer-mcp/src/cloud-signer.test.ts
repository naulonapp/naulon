/**
 * BUY-2 — the cloud MemoSigner. It turns a wayfarer sign request into a POST to the cloud's
 * grant-checked /sign-memo BFF (holding the encrypted session key), so the MCP process never touches
 * a private key. This proves: the request shape (bearer token, message primitives as strings, chainId
 * from the domain), the happy-path signature return, and TYPED failures on 402 (grant) / 403 (guard).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudMemoSigner, cloudPopSigner, cloudSignerFromEnv, GrantExceededError, GrantExpiredError, SignerError } from "./cloud-signer.ts";
import type { MemoSigner } from "@naulon/wayfarer";

const SESSION = ("0x" + "2".repeat(40)) as `0x${string}`;
const PAYEE = ("0x" + "1".repeat(40)) as `0x${string}`;
const NONCE = ("0x" + "a".repeat(64)) as `0x${string}`;

const args = {
  domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: "0x3600000000000000000000000000000000000000" },
  types: { TransferWithAuthorization: [] },
  primaryType: "TransferWithAuthorization",
  message: { from: SESSION, to: PAYEE, value: 5000n, validAfter: 0n, validBefore: 1_800_000_000n, nonce: NONCE },
} as unknown as Parameters<MemoSigner["signTypedData"]>[0];

function stub(status: number, body: unknown) {
  const seen: { url?: string; init?: { method?: string; headers?: Record<string, string>; body?: string } } = {};
  const fetchImpl = (async (url: string, init?: typeof seen.init) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test("happy path: POSTs message primitives + returns the signature", async () => {
  const { fetchImpl, seen } = stub(200, { signature: "0xdeadbeef" });
  const signer = cloudMemoSigner({ endpoint: "https://cloud.test", token: "sess-tok", address: SESSION, fetchImpl });
  const sig = await signer.signTypedData(args);
  assert.equal(sig, "0xdeadbeef");
  assert.equal(seen.url, "https://cloud.test/_naulon/buyer-wallet/sign-memo");
  assert.equal(seen.init?.headers?.authorization, "Bearer sess-tok");
  const sent = JSON.parse(seen.init!.body!);
  assert.equal(sent.chainId, 5042002);
  assert.deepEqual(sent.message, {
    from: SESSION, to: PAYEE, value: "5000", validAfter: "0", validBefore: "1800000000", nonce: NONCE,
  });
});

test("signer address is the provisioned session address", () => {
  const { fetchImpl } = stub(200, { signature: "0x00" });
  assert.equal(cloudMemoSigner({ endpoint: "x", token: "t", address: SESSION, fetchImpl }).address, SESSION);
});

test("402 → GrantExceededError carrying remainingMicro", async () => {
  const { fetchImpl } = stub(402, { error: "grant_exceeded", remainingMicro: 42 });
  const signer = cloudMemoSigner({ endpoint: "x", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(signer.signTypedData(args), (err: unknown) => {
    assert.ok(err instanceof GrantExceededError);
    assert.equal(err.remainingMicro, 42);
    return true;
  });
});

test("402 grant_expired → GrantExpiredError (renew, funds intact — NOT a top-up)", async () => {
  const { fetchImpl } = stub(402, { error: "grant_expired", remainingMicro: 4990000 });
  const signer = cloudMemoSigner({ endpoint: "x", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(signer.signTypedData(args), (err: unknown) => {
    assert.ok(err instanceof GrantExpiredError, "a lapsed window is renew, not top-up");
    assert.equal((err as GrantExpiredError).remainingMicro, 4990000);
    return true;
  });
});

test("error-class messages LEAD with the raw code so memo.ts's prefix classifier can bridge them", () => {
  // The bug this fixes: memo.ts classifies a signer throw by err.message prefix (classifySignerRefusal's
  // regex ^([a-z_]+)); the old prose message ("buyer wallet grant exceeded") matched nothing → the refusal
  // fell through to origin_error/retryable. The messages must lead with the raw code + the same
  // "(remaining N)" suffix as in-process-signer.ts. The code→errorCode half is covered in wayfarer's
  // buyer.test.ts (classifySignerRefusal), so this + that = the whole bridge.
  assert.match(new GrantExceededError(42).message, /^grant_exceeded \(remaining 42\)$/);
  assert.match(new GrantExpiredError(4990000).message, /^grant_expired \(remaining 4990000\)$/);
  assert.match(new GrantExceededError().message, /^grant_exceeded$/); // no suffix when remaining is unknown
});

test("403 → SignerError carrying the status + code", async () => {
  const { fetchImpl } = stub(403, { error: "bad_from" });
  const signer = cloudMemoSigner({ endpoint: "x", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(signer.signTypedData(args), (err: unknown) => {
    assert.ok(err instanceof SignerError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "bad_from");
    return true;
  });
});

test("200 without a signature → SignerError (never returns undefined)", async () => {
  const { fetchImpl } = stub(200, { notASignature: true });
  const signer = cloudMemoSigner({ endpoint: "x", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(signer.signTypedData(args), SignerError);
});

// ── cloudSignerFromEnv — the env gate (server-config, never tool args) ──
const FULL_ENV = {
  NAULON_CLOUD_ENDPOINT: "https://cloud.test",
  NAULON_CLOUD_TOKEN: "sess-tok",
  NAULON_BUYER_SESSION_ADDRESS: SESSION,
};

test("all three env vars set → a signer for the configured session address", () => {
  const signer = cloudSignerFromEnv(FULL_ENV);
  assert.ok(signer);
  assert.equal(signer.address, SESSION);
});

test("any missing var → undefined (fall back to the BYO-key path)", () => {
  for (const drop of Object.keys(FULL_ENV)) {
    const env = { ...FULL_ENV, [drop]: undefined };
    assert.equal(cloudSignerFromEnv(env), undefined, `missing ${drop} ⇒ no cloud signer`);
  }
});

test("a malformed session address → undefined (never build a signer for a bad address)", () => {
  assert.equal(cloudSignerFromEnv({ ...FULL_ENV, NAULON_BUYER_SESSION_ADDRESS: "not-an-address" }), undefined);
});

// ── C2 — cloudPopSigner (holder-of-key proof via /sign-pop, grant-free) ────────

test("cloudPopSigner: POSTs the message to /sign-pop with the bearer + address, returns the signature", async () => {
  const { fetchImpl, seen } = stub(200, { signature: "0xpop" });
  const w = cloudPopSigner({ endpoint: "https://cloud.test", token: "sess-tok", address: SESSION, fetchImpl });
  assert.equal(w.address, SESSION);
  assert.equal(w.mock, false);
  const sig = await w.signMessage!("naulon-pop\nv=1\naud=gate://naulon\njti=j\nslug=s\nts=1\nnonce=n");
  assert.equal(sig, "0xpop");
  assert.equal(seen.url, "https://cloud.test/_naulon/buyer-wallet/sign-pop");
  assert.equal(seen.init?.headers?.authorization, "Bearer sess-tok");
  const sent = JSON.parse(seen.init!.body!);
  assert.equal(sent.address, SESSION);
  assert.match(sent.message, /^naulon-pop\n/);
});

test("cloudPopSigner: a non-ok response throws a typed SignerError", async () => {
  const { fetchImpl } = stub(403, { error: "bad_from" });
  const w = cloudPopSigner({ endpoint: "https://cloud.test", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(() => w.signMessage!("naulon-pop\nv=1\n"), (e: unknown) => e instanceof SignerError && (e as SignerError).status === 403);
});

test("cloudPopSigner: an ok response with no signature throws no_signature", async () => {
  const { fetchImpl } = stub(200, {});
  const w = cloudPopSigner({ endpoint: "https://cloud.test", token: "t", address: SESSION, fetchImpl });
  await assert.rejects(() => w.signMessage!("naulon-pop\nv=1\n"), (e: unknown) => e instanceof SignerError && (e as SignerError).code === "no_signature");
});
