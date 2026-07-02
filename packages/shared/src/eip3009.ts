/**
 * EIP-3009 (`transferWithAuthorization`) protocol descriptor — the SDK-free, pure-data
 * definition of a USDC EIP-3009 authorization and the EIP-712 domain it is signed
 * against. Both sides of the memo self-relay rail consume this single source of truth:
 * the BUYER signs against it (wayfarer), the GATE verifies against it (tollgate). The
 * viem signing/recovery act stays in each consumer — each already depends on viem; this
 * file must not, so `shared` stays dependency-light (it is imported by the cloud control
 * plane too).
 *
 * This is the sibling of `networks.ts` `gatewayExtra` (the GatewayWallet EIP-712 domain):
 * same pattern — the protocol descriptor lives in `shared`, the crypto lives in the
 * consumer. Keep them adjacent.
 */
import type { SettlementNetwork } from "./networks.ts";

/** The buyer's EIP-3009 authorization — the exact `{from,to,value,validAfter,
 *  validBefore,nonce}` message they sign, identical in shape to the Gateway payload's
 *  `authorization` (only the EIP-712 DOMAIN they sign it against differs: the USDC
 *  token here vs the GatewayWallet contract in batched mode). */
export interface MemoAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // atomic micro-USDC (6 decimals)
  validAfter: string; // unix seconds
  validBefore: string; // unix seconds
  nonce: `0x${string}`; // bytes32
}

/** EIP-712 typed-data type for the EIP-3009 transfer authorization (what the buyer
 *  signs against the USDC domain, and what the gate recovers the signer from). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The USDC EIP-712 domain name/version — LAST-RESORT fallback only. The real values
 *  live per-network on `SettlementNetwork.usdcName`/`usdcVersion` (verified on-chain,
 *  e.g. Arc testnet = "USDC"/"2", NOT this mainnet FiatToken default), and the
 *  `USDC_EIP712_NAME` env var overrides everything. PREFLIGHT before the first real
 *  settle on a new network: confirm `name()` on its USDC contract matches the domain —
 *  a mismatch makes both the off-chain pre-verify AND the on-chain
 *  `transferWithAuthorization` reject a valid signature, with a confusing "signer != from".
 *  (`make arc-preflight` does this check.) */
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";

/** Resolve the USDC EIP-712 domain: env override → per-network verified value → the
 *  mainnet-FiatToken fallback. Never trusts the fallback for a network that declares
 *  its own (Arc), so the default path signs correctly with no env required. */
export function usdcDomain(net: SettlementNetwork, nameOverride?: string) {
  return {
    name: nameOverride ?? net.usdcName ?? USDC_EIP712_NAME,
    version: net.usdcVersion ?? USDC_EIP712_VERSION,
    chainId: net.chainId,
    verifyingContract: net.usdc,
  } as const;
}
