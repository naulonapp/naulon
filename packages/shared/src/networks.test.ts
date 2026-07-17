/**
 * Settlement network registry — the swap seam. These guard the two ways a chain
 * retarget can silently break real settlement:
 *   1. a malformed `network` (Circle's BatchEvmScheme rejects anything but
 *      `eip155:<chainId>`, so a typo here = every verify fails on that chain), and
 *   2. a network selected by SETTLEMENT_NETWORK that doesn't match what the env asked
 *      for (the whole rail reads `activeNetwork()`, so a wrong pick mis-tolls).
 *
 * resetConfig() is the seam that lets us drive SETTLEMENT_NETWORK per-test; restore
 * the env after so we don't leak a network choice into other suites.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetConfig } from "./config.ts";
import {
  activeNetwork,
  ARC_TESTNET,
  gatewayExtra,
  getNetwork,
  networkByCaip2,
  NETWORKS,
  supportsMemo,
  supportsModularWallet,
  type NetworkName,
} from "./networks.ts";

const ALL: NetworkName[] = [
  "arc", "base", "ethereum", "arbitrum", "optimism", "polygon",
  "avalanche", "unichain", "sei", "sonic", "hyperEvm", "worldChain",
  "arcTestnet", "baseSepolia",
];

afterEach(() => {
  delete process.env.SETTLEMENT_NETWORK;
  resetConfig();
});

test("every network's x402 id is exactly eip155:<chainId> (the SDK invariant)", () => {
  for (const name of ALL) {
    const net = NETWORKS[name];
    assert.equal(net.network, `eip155:${net.chainId}`, `${name} network must be eip155:<chainId>`);
    assert.equal(net.chainName, name, `${name} chainName must match its registry key`);
  }
});

test("testnet flag and gateway wallet are consistent per network", () => {
  // Base is the only real-money network; the testnets carry Circle's testnet wallet.
  assert.equal(NETWORKS.base.testnet, false);
  assert.equal(NETWORKS.arcTestnet.testnet, true);
  assert.equal(NETWORKS.baseSepolia.testnet, true);

  // Mainnet vs testnet GatewayWallet deployments differ — a mismatch would point the
  // x402 `extra.verifyingContract` at the wrong contract.
  assert.notEqual(NETWORKS.base.gatewayWallet, NETWORKS.arcTestnet.gatewayWallet);
  assert.equal(NETWORKS.arcTestnet.gatewayWallet, NETWORKS.baseSepolia.gatewayWallet);

  // The facilitator endpoint follows the testnet flag (so the swap is one env var).
  for (const name of ALL) {
    const net = NETWORKS[name];
    assert.equal(net.gatewayApiUrl.includes("testnet"), net.testnet, `${name} facilitator vs testnet flag`);
  }
});

test("getNetwork returns the named entry; ARC_TESTNET is the back-compat alias", () => {
  assert.equal(getNetwork("base"), NETWORKS.base);
  assert.equal(ARC_TESTNET, NETWORKS.arcTestnet);
});

test("gatewayExtra names the network's own verifying contract", () => {
  assert.deepEqual(gatewayExtra(NETWORKS.base), {
    name: "GatewayWalletBatched",
    version: "1",
    verifyingContract: NETWORKS.base.gatewayWallet,
  });
});

test("activeNetwork defaults to arcTestnet (safe: never silently mainnet)", () => {
  delete process.env.SETTLEMENT_NETWORK;
  resetConfig();
  assert.equal(activeNetwork(), NETWORKS.arcTestnet);
  assert.equal(activeNetwork().testnet, true);
});

test("activeNetwork follows SETTLEMENT_NETWORK — the swap is one env var", () => {
  process.env.SETTLEMENT_NETWORK = "base";
  resetConfig();
  assert.equal(activeNetwork(), NETWORKS.base);
  assert.equal(activeNetwork().network, "eip155:8453");
  assert.equal(activeNetwork().testnet, false);
});

// --- Memo capability matrix -------------------------------------------------
// The memo (Arc Memo predeploy) is a per-network CAPABILITY, not a chainName check.
// These guard the invariant the settle path leans on: ONLY Arc carries it, so a swap
// to either Base network omits memos automatically — there is no Base equivalent.

test("only Arc carries the memo capability — Base networks never do", () => {
  assert.equal(supportsMemo(NETWORKS.arcTestnet), true, "arcTestnet must support memo");
  assert.equal(supportsMemo(NETWORKS.baseSepolia), false, "baseSepolia must NOT carry a memo field");
  assert.equal(supportsMemo(NETWORKS.base), false, "base must NOT carry a memo field");
});

test("the memo contract is the verified Arc Memo predeploy", () => {
  // Cross-checked against testnet.arcscan.app (Blockscout). If Arc redeploys it, this
  // catches the stale copy before a self-relay settle targets the wrong contract.
  assert.equal(NETWORKS.arcTestnet.memo?.contract, "0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
});

test("networkByCaip2 maps a known CAIP-2 id back to its network", () => {
  // The settle path resolves the per-request chain from the leg's advertised
  // `requirements.network` (an `eip155:<chainId>`), never a process global — this
  // reverse lookup is that resolution.
  assert.equal(networkByCaip2("eip155:8453"), NETWORKS.base);
  assert.equal(networkByCaip2("eip155:5042002"), NETWORKS.arcTestnet);
  assert.equal(networkByCaip2("eip155:84532"), NETWORKS.baseSepolia);
});

test("networkByCaip2 returns undefined for an unknown id (caller falls back to activeNetwork)", () => {
  // eip155:1 (Ethereum mainnet) is now a registered chain in the 14-chain fleet, so an
  // unmapped id must be one truly outside the registry.
  assert.equal(networkByCaip2("eip155:999999999"), undefined);
  assert.equal(networkByCaip2("garbage"), undefined);
  assert.equal(networkByCaip2(""), undefined);
});

test("supportsMemo narrows the type so the settle path reads memo without a non-null assertion", () => {
  const net = NETWORKS.arcTestnet;
  if (supportsMemo(net)) {
    // Inside the guard, `net.memo` is non-optional — this is the ergonomic the
    // field-presence gate buys the settle path.
    assert.match(net.memo.contract, /^0x[0-9a-fA-F]{40}$/);
  } else {
    assert.fail("arcTestnet should have narrowed to memo-capable");
  }
});

test("all 12 mainnets carry the mainnet GatewayWallet; both testnets carry the testnet one", () => {
  const MAINNET_GW = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
  const TESTNET_GW = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
  for (const name of ALL) {
    const net = NETWORKS[name];
    assert.equal(net.gatewayWallet, net.testnet ? TESTNET_GW : MAINNET_GW, `${name} gatewayWallet vs testnet flag`);
  }
});

test("modular-wallet capability is present exactly on the modular-supported chains", () => {
  const MODULAR = new Set<NetworkName>([
    "base", "ethereum", "arbitrum", "optimism", "polygon", "avalanche", "unichain",
    "arcTestnet", "baseSepolia",
  ]);
  for (const name of ALL) {
    const net = NETWORKS[name];
    assert.equal(supportsModularWallet(net), MODULAR.has(name), `${name} modular capability`);
    if (supportsModularWallet(net)) assert.equal(typeof net.modularChainName, "string");
  }
  // The four gateway-only mainnets + arc-mainnet must NOT advertise an embedded wallet.
  for (const name of ["sei", "sonic", "hyperEvm", "worldChain", "arc"] as NetworkName[]) {
    assert.equal(supportsModularWallet(NETWORKS[name]), false, `${name} must be API-buyers-only`);
  }
});

test("arc mainnet ships WITHOUT a memo field until the predeploy is verified on mainnet", () => {
  assert.equal(supportsMemo(NETWORKS.arc), false, "arc mainnet memo is unverified — must be absent");
  assert.equal(NETWORKS.arc.testnet, false);
  assert.equal(NETWORKS.arc.network, "eip155:5042");
});
