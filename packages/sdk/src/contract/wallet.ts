/**
 * The wallet address primitive — the single home for the `0x…40-hex` regex that
 * was previously hand-copied four times across the gate, the publisher, and the
 * settlement receiver.
 *
 * Two faces of the same rule:
 *  - `walletSchema` validates a PLAIN string (publisher-friendly; what crosses the
 *    wire and what the credits/settlement schemas compose).
 *  - the branded `WalletAddress` + `walletAddress()` constructor give internal code
 *    type-safety against mixing an arbitrary string with a validated address.
 */
import { z } from "zod";

/** The one regex. An EVM/Arc address: `0x` + 40 hex digits. */
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** An on-chain wallet address (Arc / EVM-style 0x...). Branded to avoid mixups. */
export type WalletAddress = string & { readonly __brand: "WalletAddress" };

/** Zod validator over a plain string — composes into the credits + settlement schemas. */
export const walletSchema = z
  .string()
  .regex(WALLET_RE, "wallet must be a 0x-prefixed 40-hex address");

/** Validate + brand. Throws on a malformed address so a bad value can never become a `payTo`. */
export function walletAddress(value: string): WalletAddress {
  if (!WALLET_RE.test(value)) {
    throw new Error(`invalid wallet address: ${value}`);
  }
  return value as WalletAddress;
}
