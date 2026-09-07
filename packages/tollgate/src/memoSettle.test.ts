/**
 * Settlement ROUTING on a memo-capable chain — the regression guard for the 2026-09-04 change that
 * took Arc off the Memo self-relay and onto Circle Gateway's batching facilitator.
 *
 * This file used to prove the opposite: that `PAYMENT_MODE=gateway` plus a network shipping the
 * Memo predeploy self-relayed one on-chain transaction per toll. That is INDIVIDUAL settlement, and
 * Circle prices it out of the band this product sells in — their own figure is a ~$0.01 viable
 * minimum per payment against $0.000001 for batched settlement, and the 30 real production settles
 * measured $0.0023–$0.0034 of gas each against a $0.003 toll.
 *
 * What must stay true now is the inverse, and it earns a test because the failure is silent and
 * expensive. The Memo predeploy stays in the registry — Arc genuinely ships it, and tagging a
 * transaction that has to happen anyway (a withdrawal) is still worth doing — so a later reader can
 * easily read `supportsMemo` as a rail selector again and route Arc back to the relayer. These
 * assertions say that carrying the predeploy is NOT a settlement instruction.
 *
 * The relay broadcaster is armed to THROW: nothing here may reach it. Env is set BEFORE importing
 * x402 so the module-level config binds gateway + arcTestnet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
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
const { setRelayBroadcasterForTest, resetRelayBroadcaster } = await import("./arcRelay.ts");
const { NETWORKS, networkByCaip2, supportsMemo } = await import("@naulon/shared");

const ARC = NETWORKS.arcTestnet;
const AUTHOR = "0x1111111111111111111111111111111111111111" as const;

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

/** Run `verifyAndSettle` with the relayer armed to explode, and report whether it was touched.
 *  The facilitator call itself has no network here and will fail; WHERE it fails is the point. */
async function settleWatchingTheRelayer(
  sig: string,
  legs: Parameters<typeof x402.verifyAndSettle>[1],
  now: number,
): Promise<{ relayed: number }> {
  let relayed = 0;
  setRelayBroadcasterForTest(async () => {
    relayed += 1;
    return { success: false, errorReason: "the settle path must not self-relay" };
  });
  try {
    await x402.verifyAndSettle(sig, legs, now).catch(() => undefined);
  } finally {
    resetRelayBroadcaster();
  }
  return { relayed };
}

test("arcTestnet still declares the Memo predeploy — the capability was demoted, not deleted", () => {
  // Deleting the field instead of demoting it would silently answer "no memo here" to every
  // consumer that asks about the CHAIN — including a withdrawal we may want to tag on-chain.
  assert.equal(supportsMemo(ARC), true, "arcTestnet must keep its memo predeploy entry");
  assert.ok(ARC.memo?.contract, "the predeploy address is the capability");
});

test("a memo-capable chain settles through the facilitator, never the relayer", async () => {
  const now = 1_750_000_000_000;
  const req = reqFor("license:jti-77");
  const sig = await x402.buildMemoSignature(BUYER_KEY, req, now);
  const { relayed } = await settleWatchingTheRelayer(sig, req, now);
  assert.equal(relayed, 0, "verifyAndSettle must not broadcast through the Memo relayer");
});

test("no memoId supplied changes nothing — the memo never decided the rail", async () => {
  const now = 1_750_000_000_000;
  const sig = await x402.buildMemoSignature(BUYER_KEY, reqFor(), now);
  const { relayed } = await settleWatchingTheRelayer(sig, reqFor(), now);
  assert.equal(relayed, 0, "a missing memoId must not resurrect the self-relay path");
});

test("a mismatched authorization still never reaches a chain", async () => {
  const now = 1_750_000_000_000;
  const signedReq = reqFor("jti-x");
  const sig = await x402.buildMemoSignature(BUYER_KEY, signedReq, now);
  const tamperedLeg = { ...signedReq, payTo: "0x2222222222222222222222222222222222222222" };
  const { relayed } = await settleWatchingTheRelayer(sig, tamperedLeg, now);
  assert.equal(relayed, 0, "must not relay a mismatched authorization");
});

test("the buyer's rail picker keys off a fact this registry still provides", () => {
  // Buyer and gate must choose the same envelope or the settle dies as "malformed memo payload".
  // wayfarer's `isGateway402` now answers "Gateway" for any CAIP-2 it can resolve, so the registry
  // resolving arcTestnet is the fact that keeps the two sides agreeing.
  assert.ok(networkByCaip2(ARC.network), "arcTestnet must resolve from its CAIP-2 id");
});
