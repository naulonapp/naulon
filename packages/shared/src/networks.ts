/**
 * Settlement network registry. One switch (`SETTLEMENT_NETWORK`) selects the chain
 * the whole rail tolls on — the x402 quote, the settlement body, the discovery
 * manifest, and the buyer client all read the active network from here, so moving
 * between Arc testnet, Base Sepolia, and Base mainnet is an env change, not a code
 * change.
 *
 * Source of truth for every constant: the @circle-fin/x402-batching SDK
 * (dist/client chain configs) and circlefin/arc-nanopayments. Kept here, not
 * imported from the SDK, so `shared` carries no dependency on it — the SDK is
 * lazy-loaded only in gateway mode (see tollgate/x402.ts, wayfarer/gateway.ts).
 *
 * NOTE: the rail is Circle Gateway on every entry. "Swappable" here means swappable
 * across Circle's chains, NOT across facilitators — there is deliberately one rail.
 */
import { getConfig } from "./config.ts";

/** The chains this gate can settle on — each a SupportedChainName in the SDK. */
export type NetworkName =
  | "arc" | "base" | "ethereum" | "arbitrum" | "optimism" | "polygon"
  | "avalanche" | "unichain" | "sei" | "sonic" | "hyperEvm" | "worldChain"
  | "arcTestnet" | "baseSepolia";

export interface SettlementNetwork {
  /** GatewayClient `chain` key — must match a SupportedChainName in the SDK. */
  chainName: NetworkName;
  /** x402 network id. MUST be `eip155:<chainId>` — the SDK's BatchEvmScheme
   *  rejects any other format (verify compares against `eip155:${chain.id}`). */
  network: string;
  chainId: number;
  /** Native USDC token (ERC-20). */
  usdc: `0x${string}`;
  /** USDC EIP-712 domain `name`/`version` for RAW EIP-3009 signing (the memo
   *  self-relay rail). VERIFIED per-network, never assumed: Arc testnet's USDC names
   *  itself "USDC"/"2" on-chain (NOT the mainnet FiatToken "USD Coin") — a mismatch
   *  silently rejects every signature (recovers signer != from). Only the memo rail
   *  reads these (the Gateway path signs the GatewayWallet domain via `gatewayExtra`),
   *  so they are optional and set only where a memo settle runs. The `USDC_EIP712_NAME`
   *  env var overrides `name` for a deploy that hits an unexpected on-chain value. */
  usdcName?: string;
  usdcVersion?: string;
  /** GatewayWallet contract — the x402 `extra.verifyingContract`. Differs between
   *  Circle's testnet and mainnet deployments, so it lives per-network. */
  gatewayWallet: `0x${string}`;
  /** Circle Gateway facilitator endpoint. The SDK 3.x defaults to mainnet, so a
   *  testnet network must point the seller-side BatchFacilitatorClient here. */
  gatewayApiUrl: string;
  rpcUrl: string;
  /** false only for a real-money mainnet — the guard behind the safe default. */
  testnet: boolean;
  /** Arc-only transaction-extension capability. Present ONLY on chains that ship the
   *  Memo predeploy (Arc); ABSENT on Base / Base Sepolia (they have no equivalent).
   *  The settle path gates memo emission on the PRESENCE of this field, NEVER on
   *  chainName — so a chain swap to Base omits memos automatically (illegal state
   *  unrepresentable). The memo wraps the buyer→author transfer via a self-relay,
   *  which stays custody-free (the relayer pays gas, never touches the USDC). */
  memo?: {
    /** The Memo predeploy. `memo(target,data,memoId,memoData)` executes the subcall
     *  through the CALL_FROM precompile (preserving the relayer as caller) AND emits
     *  an indexed `Memo(sender,target,callDataHash,memoId,memo,memoIndex)` event.
     *  Verified on testnet.arcscan.app (Blockscout). Arc-testnet-only. */
    contract: `0x${string}`;
  };
  /** Circle Modular Wallets transport URL suffix (the browser embedded passkey wallet).
   *  Present ONLY on chains Circle's Modular Wallets support; ABSENT on the four
   *  gateway-only mainnets (sei/sonic/hyperEvm/worldChain) and Arc mainnet. The portal
   *  gates its embedded-wallet UI on the PRESENCE of this field (field-presence
   *  capability, mirroring `memo`/`supportsMemo`) — a chain without it takes
   *  API/agent buyers only. The modular transport URL is `clientUrl + '/' + this`. */
  modularChainName?: string;
}

/** Field-presence capability gate — true iff this network ships the Memo predeploy.
 *  The settle path narrows on THIS, never on `chainName`, so adding a memo-capable
 *  chain (or swapping to a memo-less one) needs no settle-path edit. */
export function supportsMemo(
  net: SettlementNetwork,
): net is SettlementNetwork & { memo: NonNullable<SettlementNetwork["memo"]> } {
  return net.memo !== undefined;
}

/** Field-presence capability gate — true iff Circle Modular Wallets support this chain
 *  (so the portal can offer the in-browser passkey wallet). Narrowed like supportsMemo. */
export function supportsModularWallet(
  net: SettlementNetwork,
): net is SettlementNetwork & { modularChainName: string } {
  return net.modularChainName !== undefined;
}

const TESTNET_FACILITATOR = "https://gateway-api-testnet.circle.com";
const MAINNET_FACILITATOR = "https://gateway-api.circle.com";

export const NETWORKS: Record<NetworkName, SettlementNetwork> = {
  arcTestnet: {
    chainName: "arcTestnet", network: "eip155:5042002", chainId: 5042002,
    usdc: "0x3600000000000000000000000000000000000000",
    usdcName: "USDC", usdcVersion: "2",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayApiUrl: TESTNET_FACILITATOR, rpcUrl: "https://rpc.testnet.arc.network",
    testnet: true, modularChainName: "arcTestnet",
    memo: { contract: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" },
  },
  baseSepolia: {
    chainName: "baseSepolia", network: "eip155:84532", chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayApiUrl: TESTNET_FACILITATOR, rpcUrl: "https://sepolia-preconf.base.org",
    testnet: true, modularChainName: "baseSepolia",
  },
  base: {
    chainName: "base", network: "eip155:8453", chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://mainnet.base.org",
    testnet: false, modularChainName: "base",
  },
  ethereum: {
    chainName: "ethereum", network: "eip155:1", chainId: 1,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://ethereum-rpc.publicnode.com",
    testnet: false, modularChainName: "ethereum",
  },
  arbitrum: {
    chainName: "arbitrum", network: "eip155:42161", chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://arb1.arbitrum.io/rpc",
    testnet: false, modularChainName: "arbitrum",
  },
  optimism: {
    chainName: "optimism", network: "eip155:10", chainId: 10,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://mainnet.optimism.io",
    testnet: false, modularChainName: "optimism",
  },
  polygon: {
    chainName: "polygon", network: "eip155:137", chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://polygon-rpc.com",
    testnet: false, modularChainName: "polygon",
  },
  avalanche: {
    chainName: "avalanche", network: "eip155:43114", chainId: 43114,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    testnet: false, modularChainName: "avalanche",
  },
  unichain: {
    chainName: "unichain", network: "eip155:130", chainId: 130,
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://mainnet.unichain.org",
    testnet: false, modularChainName: "unichain",
  },
  sei: {
    chainName: "sei", network: "eip155:1329", chainId: 1329,
    usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://evm-rpc.sei-apis.com",
    testnet: false,
  },
  sonic: {
    chainName: "sonic", network: "eip155:146", chainId: 146,
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://rpc.soniclabs.com",
    testnet: false,
  },
  hyperEvm: {
    chainName: "hyperEvm", network: "eip155:999", chainId: 999,
    usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR, rpcUrl: "https://rpc.hyperliquid.xyz/evm",
    testnet: false,
  },
  worldChain: {
    chainName: "worldChain", network: "eip155:480", chainId: 480,
    usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR,
    rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
    testnet: false,
  },
  arc: {
    chainName: "arc", network: "eip155:5042", chainId: 5042,
    usdc: "0x3600000000000000000000000000000000000000",
    // Arc mainnet's USDC EIP-712 domain is UNVERIFIED (chain not public). Left unset;
    // the memo rail (which reads these) is absent until verified on-chain at enrollment.
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR,
    // No public RPC yet — the settle path substitutes cfg.ARC_RPC_URL (fail-loud if unset).
    rpcUrl: "https://rpc.arc.network",
    testnet: false,
    // NO memo field: the Arc mainnet Memo predeploy is unverified. Add only after an
    // on-chain read confirms it (illegal-state-unrepresentable — never assume a capability).
  },
};

/** Back-compat alias for the original single-network export + interface. */
export const ARC_TESTNET: SettlementNetwork = NETWORKS.arcTestnet;
/** @deprecated use {@link SettlementNetwork}. */
export type ArcNetwork = SettlementNetwork;

/** Look up a network by name. */
export function getNetwork(name: NetworkName): SettlementNetwork {
  return NETWORKS[name];
}

/** Reverse the registry: an x402 CAIP-2 id (`eip155:<chainId>`) → its
 *  SettlementNetwork. The settle path resolves the per-request chain from the leg's
 *  advertised `requirements.network`, never a global — this is that resolution.
 *  Unknown id → undefined (the caller falls back to `activeNetwork()`, keeping the
 *  single-tenant default byte-identical). */
export function networkByCaip2(caip2: string): SettlementNetwork | undefined {
  return Object.values(NETWORKS).find((n) => n.network === caip2);
}

/** The network the gate is configured to settle on (`SETTLEMENT_NETWORK`). */
export function activeNetwork(): SettlementNetwork {
  return NETWORKS[getConfig().SETTLEMENT_NETWORK];
}

/** The Arc self-relay gas EOA for a network: the shared testnet key on testnet, a
 *  SEPARATE mainnet key on mainnet — unlike `facilitatorBearer` (Circle's key, which
 *  falls back testnet→live), there is NO fallback here: mainnet gas is real money, so
 *  a missing mainnet key must never silently spend the testnet one. Reads config live
 *  on every call (not a module-frozen snapshot) so a `resetConfig()` mid-process is
 *  observed immediately. Callers each keep their own 0x-normalization + "which var is
 *  missing" error message — this only selects which raw value applies. */
export function relayerKeyFor(net: SettlementNetwork): string | undefined {
  const cfg = getConfig();
  return net.testnet ? cfg.RELAYER_PRIVATE_KEY : cfg.RELAYER_PRIVATE_KEY_MAINNET;
}

/** The Gateway batching x402 `extra` block, naming the verifying contract. */
export function gatewayExtra(net: SettlementNetwork = activeNetwork()): Record<string, unknown> {
  return { name: "GatewayWalletBatched", version: "1", verifyingContract: net.gatewayWallet };
}

/** Convert a decimal USDC string/number to atomic units (6 decimals). */
export function toAtomicUsdc(amount: number | string): string {
  const n = typeof amount === "string" ? parseFloat(amount.replace("$", "")) : amount;
  return Math.round(n * 1_000_000).toString();
}
