/**
 * Arc self-relay (memo) settlement — no-funds unit suite. Proves the settlement
 * TRANSACTION is built correctly against the real Memo + USDC ABIs and that the
 * custody-free + signature invariants hold, all WITHOUT touching a chain (the broadcast
 * is the one injected seam). The capability matrix (only Arc carries memo) lives in
 * shared/networks.test.ts; this is the rail that rides it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NETWORKS, supportsMemo, type MemoAuthorization } from "@naulon/shared";
import { decodeFunctionData, hexToString } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assertCustodyFree,
  buildMemoSettlementTx,
  encodeUsdcTransfer,
  MEMO_ABI,
  preverifyEip3009,
  resetRelayBroadcaster,
  settleViaMemo,
  setRelayBroadcasterForTest,
  signMemoAuthorization,
  toMemoData,
  toMemoId,
  USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
} from "./arcRelay.ts";

// Narrowed once so the whole suite sees `ARC.memo` as non-optional (the registry sets
// it; the guard makes that a type-level fact, not a `!` everywhere).
const ARC = (() => {
  const n = NETWORKS.arcTestnet;
  if (!supportsMemo(n)) throw new Error("arcTestnet must be memo-capable");
  return n;
})();
// Ephemeral keys generated per run — never funded, used only to sign/recover offline.
const BUYER_KEY = generatePrivateKey();
const RELAYER_KEY = generatePrivateKey();
const buyer = privateKeyToAccount(BUYER_KEY);
const relayer = privateKeyToAccount(RELAYER_KEY);
const AUTHOR = "0x1111111111111111111111111111111111111111" as const;

afterEach(() => resetRelayBroadcaster());

function authFor(to: `0x${string}`, value = "5000"): MemoAuthorization {
  return {
    from: buyer.address,
    to,
    value,
    validAfter: "0",
    validBefore: "99999999999",
    nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
  };
}

test("toMemoId: 32-byte hex passes through; any string keccak256s to bytes32", async () => {
  const raw = ("0x" + "cd".repeat(32)) as `0x${string}`;
  assert.equal(await toMemoId(raw), raw, "already-bytes32 must pass through unchanged");
  const hashed = await toMemoId("license:jti-abc-123");
  assert.match(hashed, /^0x[0-9a-f]{64}$/, "string id must become a bytes32");
  assert.equal(await toMemoId("license:jti-abc-123"), hashed, "must be deterministic");
  assert.notEqual(hashed, await toMemoId("license:jti-xyz-999"), "distinct ids → distinct memoIds");
});

test("encodeUsdcTransfer encodes the bytes-signature EIP-3009 overload, decodes back exactly", async () => {
  const auth = authFor(AUTHOR, "12345");
  const sig = ("0x" + "11".repeat(65)) as `0x${string}`;
  const data = await encodeUsdcTransfer(auth, sig);
  const decoded = decodeFunctionData({ abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI, data });
  assert.equal(decoded.functionName, "transferWithAuthorization");
  const [from, to, value, validAfter, validBefore, nonce, signature] = decoded.args;
  assert.equal((from as string).toLowerCase(), auth.from.toLowerCase());
  assert.equal((to as string).toLowerCase(), auth.to.toLowerCase());
  assert.equal(value, 12345n);
  assert.equal(validAfter, 0n);
  assert.equal(validBefore, BigInt(auth.validBefore));
  assert.equal(nonce, auth.nonce);
  assert.equal(signature, sig);
});

test("buildMemoSettlementTx targets the Memo predeploy and nests the USDC transfer + memo", async () => {
  const auth = authFor(AUTHOR, "5000");
  const sig = ("0x" + "22".repeat(65)) as `0x${string}`;
  const memoId = await toMemoId("license:jti-1");
  const memoData = await toMemoData("naulon:cite:slug-1");
  const tx = await buildMemoSettlementTx({ net: ARC, auth, signature: sig, memoId, memoData });

  assert.equal(tx.to, ARC.memo.contract, "outer tx must target the Memo contract");
  const outer = decodeFunctionData({ abi: MEMO_ABI, data: tx.data });
  assert.equal(outer.functionName, "memo");
  const [target, innerData, gotMemoId, gotMemoData] = outer.args;
  assert.equal((target as string).toLowerCase(), ARC.usdc.toLowerCase(), "memo wraps a call to USDC");
  assert.equal(gotMemoId, memoId);
  assert.equal(hexToString(gotMemoData as `0x${string}`), "naulon:cite:slug-1", "memoData round-trips");

  // The nested call is exactly the buyer's transferWithAuthorization (buyer→author).
  const inner = decodeFunctionData({ abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI, data: innerData as `0x${string}` });
  assert.equal((inner.args[1] as string).toLowerCase(), AUTHOR.toLowerCase(), "funds go to the author");
  assert.equal(inner.args[2], 5000n);
});

test("assertCustodyFree rejects a redirected or relayer-bound recipient", () => {
  // Happy path: author recipient, distinct relayer → no throw.
  assert.doesNotThrow(() => assertCustodyFree(authFor(AUTHOR), AUTHOR, relayer.address));
  // Recipient != the leg's payTo → a mis-wired leg.
  assert.throws(
    () => assertCustodyFree(authFor(AUTHOR), "0x2222222222222222222222222222222222222222", relayer.address),
    /custody violation/,
  );
  // Funds would land on the relayer itself → pooling.
  assert.throws(() => assertCustodyFree(authFor(relayer.address), relayer.address, relayer.address), /custody violation/);
});

test("sign → preverify round-trips; tamper / expiry are rejected", async () => {
  const now = 1_750_000_000_000; // fixed ms
  const { authorization, signature } = await signMemoAuthorization({
    privateKey: BUYER_KEY,
    net: ARC,
    payTo: AUTHOR,
    amountAtomic: "5000",
    maxTimeoutSeconds: 691200,
    nowMs: now,
  });
  assert.equal(authorization.from.toLowerCase(), buyer.address.toLowerCase());
  assert.equal(authorization.to.toLowerCase(), AUTHOR.toLowerCase());

  const ok = await preverifyEip3009(authorization, signature, ARC, now);
  assert.equal(ok.ok, true, "a freshly-signed authorization must verify");

  // Tampered amount → recovered signer no longer matches `from`.
  const tampered = { ...authorization, value: "999999" };
  const bad = await preverifyEip3009(tampered, signature, ARC, now);
  assert.equal(bad.ok, false);

  // Past the validity window.
  const expired = await preverifyEip3009(authorization, signature, ARC, now + 700000 * 1000);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.reason, /expired/);
});

test("settleViaMemo relays through the mocked broadcaster on Arc and reports the payer", async () => {
  const now = 1_750_000_000_000;
  const { authorization, signature } = await signMemoAuthorization({
    privateKey: BUYER_KEY, net: ARC, payTo: AUTHOR, amountAtomic: "5000", maxTimeoutSeconds: 691200, nowMs: now,
  });
  let captured: { to: string; data: string } | undefined;
  setRelayBroadcasterForTest(async (tx) => {
    captured = tx;
    return { success: true, transaction: "0xdeadbeef" };
  });

  const r = await settleViaMemo({
    net: ARC, auth: authorization, signature, payTo: AUTHOR, relayerAddress: relayer.address,
    memoId: await toMemoId("jti-1"), memoData: await toMemoData("m"), nowMs: now,
  });
  assert.equal(r.success, true);
  assert.equal(r.transaction, "0xdeadbeef");
  assert.equal(r.payer?.toLowerCase(), buyer.address.toLowerCase(), "payer is the buyer, not the relayer");
  assert.equal(captured?.to, ARC.memo.contract, "broadcast targeted the Memo contract");
});

test("settleViaMemo refuses a non-memo network (Base) — the capability gate at the rail", async () => {
  const now = 1_750_000_000_000;
  setRelayBroadcasterForTest(async () => ({ success: true, transaction: "0xshould-not-happen" }));
  const auth = authFor(AUTHOR);
  const r = await settleViaMemo({
    net: NETWORKS.base, auth, signature: ("0x" + "33".repeat(65)) as `0x${string}`,
    payTo: AUTHOR, relayerAddress: relayer.address,
    memoId: await toMemoId("x"), memoData: await toMemoData("m"), nowMs: now,
  });
  assert.equal(r.success, false);
  assert.match(r.errorReason ?? "", /no Memo predeploy/);
});

test("settleViaMemo rejects a custody violation before broadcasting", async () => {
  const now = 1_750_000_000_000;
  let broadcast = false;
  setRelayBroadcasterForTest(async () => {
    broadcast = true;
    return { success: true };
  });
  // payTo disagrees with the signed recipient → custody guard fires, no broadcast.
  const r = await settleViaMemo({
    net: ARC, auth: authFor(AUTHOR), signature: ("0x" + "44".repeat(65)) as `0x${string}`,
    payTo: "0x9999999999999999999999999999999999999999", relayerAddress: relayer.address,
    memoId: await toMemoId("x"), memoData: await toMemoData("m"), nowMs: now,
  });
  assert.equal(r.success, false);
  assert.equal(broadcast, false, "must not broadcast when custody-free is violated");
});
