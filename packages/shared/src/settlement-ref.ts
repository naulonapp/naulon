/**
 * What a settlement reference actually IS — the ONE implementation.
 *
 * This module deliberately has ZERO imports, and that constraint is the whole reason it exists
 * separately from `networks.ts`. The registry there reaches `getConfig()`, so anything importing it
 * drags server config (and viem) along; a browser bundle, a static page and a stdio MCP server all
 * need this classification and none of them can afford that. Plain data and pure functions have no
 * such problem, so every plane can share this one.
 *
 * Why the classification matters at all: since every chain settles through Circle Gateway's
 * batching facilitator, the reference a toll returns is USUALLY the facilitator's transfer id — a
 * UUID whose on-chain batch lands later — not a transaction hash. Calling both "the transaction"
 * is how a citation ends up pointing at `basescan.org/tx/<uuid>`, which 404s in front of the one
 * reader the proof was for.
 *
 * Three implementations of this rule existed before it lived here: `networks.ts` (the proof plane),
 * a hosted control plane's receipts/CSV classifier, and that plane's own client-bundle copy. They
 * did not agree — two of them knew about `mock` and one did not, so the buyer tools described every
 * mock-mode read as a pending Circle transfer, on the DEFAULT payment mode.
 */

/** An EVM transaction hash, and nothing else: `0x` + 64 hex. */
export function isTxHash(ref: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(ref);
}

/** What a `settlementRef` actually IS, so every surface agrees. */
export type SettlementRefKind =
  /** `0x` + 64 hex — a real transaction hash. Only these may be linked to a block explorer. */
  | "txHash"
  /** A Circle Gateway async transfer id. Real money, real record — but not a transaction. */
  | "transferId"
  /** `PAYMENT_MODE=mock` (the DEFAULT) output. Proof of nothing; must be labelled as test data. */
  | "mock"
  /** No ref recorded (unsettled, or a legacy row). */
  | "none";

/**
 * Classify a settlement reference.
 *
 * The `mock` branch is load-bearing, not defensive: `PAYMENT_MODE=mock` is the DEFAULT, and
 * `settleMock()` emits `mock-<8hex>-<amount>`. Without it every dev, demo and stdio read presents
 * as a real Circle transfer that will finalize — a claim about money that nobody made.
 */
export function settlementRefKind(ref: string | null | undefined): SettlementRefKind {
  if (!ref) return "none";
  if (isTxHash(ref)) return "txHash";
  if (ref.startsWith("mock-")) return "mock";
  return "transferId";
}
