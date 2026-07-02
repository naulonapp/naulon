/**
 * Memo-network settlement ROUTING — proves `verifyAndSettle` takes the self-relay path
 * (not Circle's facilitator) when PAYMENT_MODE=gateway AND the active network ships the
 * Memo predeploy, end to end with a mocked broadcaster (no funds, no RPC). Env is set
 * BEFORE importing x402 so the module-level config binds gateway + arcTestnet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToBytes, decodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "./x402.ts";

const RELAYER_KEY = generatePrivateKey();
const BUYER_KEY = generatePrivateKey();
process.env.PAYMENT_MODE = "gateway";
process.env.SETTLEMENT_NETWORK = "arcTestnet";
process.env.RELAYER_PRIVATE_KEY = RELAYER_KEY;
// This suite exercises settlement ROUTING, not licensing — turn licensing off so the
// gateway-mode config refine doesn't demand a stable LICENSE_SIGNING_KEY.
process.env.LICENSES_ENABLED = "false";

const x402 = await import("./x402.ts");
const { MEMO_ABI, setRelayBroadcasterForTest, resetRelayBroadcaster } = await import("./arcRelay.ts");
const { NETWORKS } = await import("@naulon/shared");

const ARC = NETWORKS.arcTestnet;
const AUTHOR = "0x1111111111111111111111111111111111111111" as const;
const buyer = privateKeyToAccount(BUYER_KEY);

function reqFor(memoId?: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC.network,
    asset: ARC.usdc,
    amount: "5000",
    payTo: AUTHOR,
    maxTimeoutSeconds: 691200,
    extra: {},
    ...(memoId ? { memoId } : {}),
  };
}

test("gateway + arcTestnet routes verifyAndSettle through the Memo self-relay, memoId on-chain", async () => {
  const now = 1_750_000_000_000;
  const req = reqFor("license:jti-77");
  const sig = await x402.buildMemoSignature(BUYER_KEY, req, now);

  let captured: { to: string; data: string } | undefined;
  setRelayBroadcasterForTest(async (tx) => {
    captured = tx;
    return { success: true, transaction: "0xfeed" };
  });
  try {
    const r = await x402.verifyAndSettle(sig, req, now);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.settlementRef, "0xfeed");
    assert.equal(r.payer?.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(captured?.to, ARC.memo?.contract, "settled through the Memo predeploy, not the facilitator");

    // The control-plane's memoId reached the actual on-chain Memo call (keccak of the id).
    const outer = decodeFunctionData({ abi: MEMO_ABI, data: captured!.data as `0x${string}` });
    assert.equal(outer.args[2], keccak256(stringToBytes("license:jti-77")), "memoId = keccak256(quote.memoId)");
  } finally {
    resetRelayBroadcaster();
  }
});

test("no memoId supplied → still relays (memo keyed off the authorization nonce)", async () => {
  const now = 1_750_000_000_000;
  const req = reqFor(); // no memoId
  const sig = await x402.buildMemoSignature(BUYER_KEY, req, now);
  let relayed = false;
  setRelayBroadcasterForTest(async () => {
    relayed = true;
    return { success: true, transaction: "0xabc" };
  });
  try {
    const r = await x402.verifyAndSettle(sig, req, now);
    assert.equal(r.ok, true, r.error);
    assert.equal(relayed, true, "a memo network always relays — it cannot fall back to Gateway");
  } finally {
    resetRelayBroadcaster();
  }
});

test("a recipient/amount mismatch between authorization and requirements is rejected (402)", async () => {
  const now = 1_750_000_000_000;
  // Buyer signs for AUTHOR/5000, but the leg requires a different payTo → no settle.
  const signedReq = reqFor("jti-x");
  const sig = await x402.buildMemoSignature(BUYER_KEY, signedReq, now);
  const tamperedLeg = { ...signedReq, payTo: "0x2222222222222222222222222222222222222222" };
  let relayed = false;
  setRelayBroadcasterForTest(async () => {
    relayed = true;
    return { success: true };
  });
  try {
    const r = await x402.verifyAndSettle(sig, tamperedLeg, now);
    assert.equal(r.ok, false);
    assert.equal(relayed, false, "must not relay a mismatched authorization");
  } finally {
    resetRelayBroadcaster();
  }
});
