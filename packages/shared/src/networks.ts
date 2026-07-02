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
export type NetworkName = "arcTestnet" | "baseSepolia" | "base";

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
}

/** Field-presence capability gate — true iff this network ships the Memo predeploy.
 *  The settle path narrows on THIS, never on `chainName`, so adding a memo-capable
 *  chain (or swapping to a memo-less one) needs no settle-path edit. */
export function supportsMemo(
  net: SettlementNetwork,
): net is SettlementNetwork & { memo: NonNullable<SettlementNetwork["memo"]> } {
  return net.memo !== undefined;
}

const TESTNET_FACILITATOR = "https://gateway-api-testnet.circle.com";
const MAINNET_FACILITATOR = "https://gateway-api.circle.com";

export const NETWORKS: Record<NetworkName, SettlementNetwork> = {
  arcTestnet: {
    chainName: "arcTestnet",
    network: "eip155:5042002",
    chainId: 5042002,
    usdc: "0x3600000000000000000000000000000000000000",
    // Verified on-chain 2026-06-19 (live Arc memo settle): the Arc-testnet USDC
    // names itself "USDC"/"2", NOT the mainnet FiatToken "USD Coin". This is the
    // EIP-712 domain the buyer's raw EIP-3009 authorization is signed against.
    usdcName: "USDC",
    usdcVersion: "2",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayApiUrl: TESTNET_FACILITATOR,
    rpcUrl: "https://rpc.testnet.arc.network",
    testnet: true,
    // Arc ships the Memo + CallFrom predeploys; Base does not. Set here, gated on
    // presence at settle time → a swap to Base drops memos with no settle-path edit.
    memo: { contract: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" },
  },
  baseSepolia: {
    chainName: "baseSepolia",
    network: "eip155:84532",
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayApiUrl: TESTNET_FACILITATOR,
    rpcUrl: "https://sepolia-preconf.base.org",
    testnet: true,
  },
  base: {
    chainName: "base",
    network: "eip155:8453",
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayApiUrl: MAINNET_FACILITATOR,
    rpcUrl: "https://mainnet.base.org",
    testnet: false,
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

/** The network the gate is configured to settle on (`SETTLEMENT_NETWORK`). */
export function activeNetwork(): SettlementNetwork {
  return NETWORKS[getConfig().SETTLEMENT_NETWORK];
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
