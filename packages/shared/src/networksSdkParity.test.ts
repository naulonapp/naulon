/**
 * Parity guard: every NETWORKS entry must match the INSTALLED SDK's CHAIN_CONFIGS
 * byte-for-byte (chainId, usdc, gatewayWallet). The SDK is the ground truth
 * (rail-seam.json groundTruthOrder); this test is what makes a silent SDK bump a RED
 * test instead of a wrong-chain settle. The SDK is a devDependency of the gate, so it
 * is present here; if a future layout hides it, this test dynamic-imports and skips
 * with a clear message rather than failing spuriously.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NETWORKS, type NetworkName } from "./networks.ts";

// SDK chainName for each of our registry keys (identical except we spell Arc mainnet "arc").
const SDK_NAME: Record<NetworkName, string> = {
  arc: "arc", base: "base", ethereum: "ethereum", arbitrum: "arbitrum",
  optimism: "optimism", polygon: "polygon", avalanche: "avalanche", unichain: "unichain",
  sei: "sei", sonic: "sonic", hyperEvm: "hyperEvm", worldChain: "worldChain",
  arcTestnet: "arcTestnet", baseSepolia: "baseSepolia",
};

test("every NETWORKS entry matches the installed SDK CHAIN_CONFIGS (chainId/usdc/gatewayWallet)", async () => {
  let CHAIN_CONFIGS: Record<string, { chain: { id: number }; usdc: string; gatewayWallet: string }>;
  try {
    ({ CHAIN_CONFIGS } = await import("@circle-fin/x402-batching/client"));
  } catch {
    console.warn("[networksSdkParity] SDK not installed — skipping parity check");
    return;
  }
  for (const [key, net] of Object.entries(NETWORKS) as [NetworkName, typeof NETWORKS[NetworkName]][]) {
    const sdk = CHAIN_CONFIGS[SDK_NAME[key]];
    assert.ok(sdk, `SDK has no config for ${key} (${SDK_NAME[key]})`);
    assert.equal(net.chainId, sdk.chain.id, `${key} chainId`);
    assert.equal(net.usdc.toLowerCase(), sdk.usdc.toLowerCase(), `${key} usdc`);
    assert.equal(net.gatewayWallet.toLowerCase(), sdk.gatewayWallet.toLowerCase(), `${key} gatewayWallet`);
  }
});
