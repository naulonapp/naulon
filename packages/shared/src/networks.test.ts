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
  ARC_PRIVATE_MAINNET_HEADER,
  arcPreviewHeaders,
  ARC_TESTNET,
  gatewayExtra,
  getNetwork,
  networkByCaip2,
  NETWORKS,
  relayerKeyFor,
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
  delete process.env.RELAYER_PRIVATE_KEY;
  delete process.env.RELAYER_PRIVATE_KEY_MAINNET;
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

test("relayerKeyFor: testnet gas EOA on testnet, mainnet gas EOA on mainnet, NO fallback either way", () => {
  process.env.RELAYER_PRIVATE_KEY = "testnet-relayer-key";
  process.env.RELAYER_PRIVATE_KEY_MAINNET = "mainnet-relayer-key";
  resetConfig();
  assert.equal(relayerKeyFor(NETWORKS.arcTestnet), "testnet-relayer-key");
  assert.equal(relayerKeyFor(NETWORKS.baseSepolia), "testnet-relayer-key");
  assert.equal(relayerKeyFor(NETWORKS.arc), "mainnet-relayer-key");
  assert.equal(relayerKeyFor(NETWORKS.base), "mainnet-relayer-key");

  // Mainnet gas is real money — unlike the facilitator bearer, there is NO fallback
  // to the testnet key when the mainnet var is unset.
  delete process.env.RELAYER_PRIVATE_KEY_MAINNET;
  resetConfig();
  assert.equal(relayerKeyFor(NETWORKS.arc), undefined, "no silent fallback to the testnet relayer key on mainnet");
  assert.equal(relayerKeyFor(NETWORKS.arcTestnet), "testnet-relayer-key", "testnet is unaffected by the mainnet var");
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

/**
 * THE COST GUARD. `memo` is not a labelling flag — it SELECTS THE SETTLEMENT RAIL.
 *
 * A memo-less network settles through Circle Gateway, which BATCHES: "Gateway collects
 * authorizations and settles net positions in bulk onchain, paying gas once per batch
 * instead of once per payment", so a settle costs us nothing per read. A memo-capable
 * network cannot use that rail (Gateway's `transferWithAuthorization` has no memo field),
 * so `settleMemo` self-relays ONE ON-CHAIN TRANSACTION PER TOLL and our relayer pays the
 * gas — see arcRelay.ts's header, "it pays gas … an operating cost".
 *
 * Measured 2026-08-27 on arcTestnet at 21 Gwei: 65k–150k gas = $0.00137–$0.00315 per
 * settle, against an operator fee of $0.0003 on the live $0.003 toll. That is a 4.5x–10x
 * LOSS on every read. Circle documents the same cliff: individual settlement is viable
 * only above ~$0.01/payment, batched settlement down to $0.000001.
 *
 * So this test pins the COMPLETE set. It is not here to describe today's registry — it is
 * here so that adding `memo` to a MAINNET entry cannot happen quietly. `arc` mainnet is the
 * one that will tempt someone: its entry says "Add only after an on-chain read confirms it",
 * which is true about the ADDRESS and silent about the ECONOMICS.
 *
 * If you are here because this test failed: the address being verified is necessary and not
 * sufficient. State what a settle will cost against the fee at the price that network will
 * carry, and only then add the network below.
 */
test("the self-relay (gas-paying) rail is TESTNET-ONLY — a mainnet memo is a per-read loss", () => {
  const selfRelay = Object.values(NETWORKS).filter(supportsMemo).map((n) => n.chainName).sort();
  assert.deepEqual(
    selfRelay,
    ["arcTestnet"],
    "a network gained the memo capability — it now self-relays and WE pay gas per toll. " +
      "Read this test's doc comment before widening the list; on mainnet this loses money on every read.",
  );
  // The invariant behind the list: nothing that settles real money may self-relay.
  for (const net of Object.values(NETWORKS)) {
    if (supportsMemo(net)) {
      assert.equal(net.testnet, true, `${net.chainName} self-relays on MAINNET — every settle burns real gas against a sub-cent fee`);
    }
  }
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

// The SDK used to own this rule and then deleted it (3.2.0 exported
// `arcPrivateMainnetHeaders()`; 3.3.0 removed it and the `arcPrivateMainnet` option that
// defaulted it on for `chain === "arc"`). These pin OUR copy, since both the facilitator
// path (tollgate `facilitatorHeaders`) and the funding path (wayfarer
// `gatewayClientConfig`) now read it from here.
test("the Arc preview header is sent on arc MAINNET and nowhere else — arcTestnet included", () => {
  assert.deepEqual(arcPreviewHeaders("arc"), { "X-ARC-PRIVATE-MAINNET-ENABLED": "true" });
  for (const name of ALL) {
    if (name === "arc") continue;
    assert.deepEqual(arcPreviewHeaders(name), {}, `${name} must not opt into the Arc preview`);
  }
  // Chains the SDK supports but this registry deliberately omits (12 extra testnets) reach
  // this function too — via wayfarer's SupportedChainName, which is wider than NetworkName.
  assert.deepEqual(arcPreviewHeaders("sepolia"), {});
});

test("the Arc preview header name is the exact string Circle's facilitator reads", () => {
  // Was `ARC_PRIVATE_MAINNET_HEADER` in the SDK until 3.3.0 deleted it; a rename here is a
  // silent 'not enrolled' on Arc mainnet, so the literal is asserted, not referenced.
  assert.equal(ARC_PRIVATE_MAINNET_HEADER, "X-ARC-PRIVATE-MAINNET-ENABLED");
  assert.equal(Object.keys(arcPreviewHeaders("arc"))[0], ARC_PRIVATE_MAINNET_HEADER);
});

test("arc mainnet ships WITHOUT a memo field until the predeploy is verified on mainnet", () => {
  assert.equal(supportsMemo(NETWORKS.arc), false, "arc mainnet memo is unverified — must be absent");
  assert.equal(NETWORKS.arc.testnet, false);
  assert.equal(NETWORKS.arc.network, "eip155:5042");
});
