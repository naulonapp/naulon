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

/**
 * The EVM burn address. Never a payee: an ERC-20 transfer to it succeeds and the funds are
 * destroyed, so it is the one address that is well-formed and still certainly wrong.
 *
 * It is not merely theoretical here. `naulon init` used to scaffold a wallet-less starter with
 * exactly this value so the generated `credits.json` would still parse, warned once on the way
 * out, and nothing downstream ever objected again — a publisher who skipped the wallet prompt
 * and later flipped `PAYMENT_MODE=gateway` tolled real readers into the void.
 */
export const BURN_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The burn address, case-insensitively. */
export function isBurnAddress(value: string): boolean {
  return value.trim().toLowerCase() === BURN_ADDRESS;
}

/**
 * Zod validator over a plain string — the FORMAT rule only.
 *
 * This is deliberately not the payee rule: x402 uses the zero address as the "payer unknown"
 * sentinel (`tollgate/src/settle.ts`), so the primitive every address flows through has to
 * accept it. Anywhere money LANDS, use `payeeWalletSchema` instead.
 */
export const walletSchema = z
  .string()
  .regex(WALLET_RE, "wallet must be a 0x-prefixed 40-hex address");

/**
 * The rule for an address money is sent TO. Format, plus a refusal of the burn address.
 *
 * A burn payee is rejected the same way a malformed one already was — the credits body does not
 * parse — rather than through a new error path of its own. That keeps one answer for "this
 * article's payee cannot receive", instead of two that behave differently.
 */
export const payeeWalletSchema = walletSchema.refine(
  (v) => !isBurnAddress(v),
  "wallet is the burn address — funds sent there are destroyed, not received",
);

/** Validate + brand. Throws on a malformed address so a bad value can never become a `payTo`. */
export function walletAddress(value: string): WalletAddress {
  if (!WALLET_RE.test(value)) {
    throw new Error(`invalid wallet address: ${value}`);
  }
  return value as WalletAddress;
}
