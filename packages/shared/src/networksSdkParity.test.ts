/**
 * Parity guard: every NETWORKS entry must match the INSTALLED SDK's CHAIN_CONFIGS
 * byte-for-byte (chainId, usdc, gatewayWallet). The installed SDK is the ground
 * truth for these hand-copied constants — this test is what turns a silent SDK
 * bump into a RED test instead of a wrong-chain settle. The SDK is a
 * devDependency of the gate, so it is present here; the only case this test
 * treats as a legitimate skip is the SDK genuinely not being installed
 * (`ERR_MODULE_NOT_FOUND`). Any other import-time failure — including a removed
 * subpath export — is real drift and is left to fail loud rather than be
 * swallowed into a false-green skip.
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

// Narrow an unknown catch value to a Node.js error code, if it has one — avoids
// an unsafe cast while still letting us distinguish "module not found" (a
// legitimate skip) from every other import-time failure (real drift, must fail).
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

test("every NETWORKS entry matches the installed SDK CHAIN_CONFIGS (chainId/usdc/gatewayWallet)", async () => {
  let CHAIN_CONFIGS: Record<string, { chain: { id: number }; usdc: string; gatewayWallet: string }>;
  try {
    ({ CHAIN_CONFIGS } = await import("@circle-fin/x402-batching/client"));
  } catch (err) {
    if (errorCode(err) === "ERR_MODULE_NOT_FOUND") {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[networksSdkParity] SDK not installed — skipping parity check: ${message}`);
      return;
    }
    // Anything else (incl. ERR_PACKAGE_PATH_NOT_EXPORTED — a removed subpath
    // export is itself drift this test exists to catch) surfaces as a failure.
    throw err;
  }
  for (const [key, net] of Object.entries(NETWORKS) as [NetworkName, typeof NETWORKS[NetworkName]][]) {
    const sdk = CHAIN_CONFIGS[SDK_NAME[key]];
    assert.ok(sdk, `SDK has no config for ${key} (${SDK_NAME[key]})`);
    assert.equal(net.chainId, sdk.chain.id, `${key} chainId`);
    assert.equal(net.usdc.toLowerCase(), sdk.usdc.toLowerCase(), `${key} usdc`);
    assert.equal(net.gatewayWallet.toLowerCase(), sdk.gatewayWallet.toLowerCase(), `${key} gatewayWallet`);
  }
});
