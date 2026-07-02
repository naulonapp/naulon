/**
 * The settlement wire contract — the body naulon POSTs to a publisher's earnings
 * receiver after a paid read settles on-chain (`POST /api/credits/settlement`).
 *
 * The PRODUCER side (`signSettlement` + the gate's `buildSettlementBody`) and the
 * VERIFY side (`verifySettlement`) both speak this shape; before this package the
 * verify-side schema existed nowhere as shared code — it was hand-rolled in the
 * reference publisher. `settlementBodySchema` is that mirror, written once.
 */
import { z } from "zod";
import { walletSchema, type WalletAddress } from "./wallet.ts";

/**
 * The contract major version. Advertise it so an agent/publisher can see which
 * contract a gate speaks; bump it (and the package major) on a breaking change.
 * Within a major, only additive-optional fields may be introduced.
 */
export const CONTRACT_VERSION = 1;

/** One author's recorded cut of a settled event, in integer micro-USDC. */
export interface SettlementSplit {
  authorId: string;
  wallet: WalletAddress;
  /** Integer micro-USDC as a string. Σ splits[].amount === grossAmount. */
  amount: string;
  /** Relative share as integer permille (decorative; `amount` is the truth). */
  weight: number;
  /** Exactly one split carries this — the wallet the on-chain leg paid. */
  primary?: true;
}

/** The exact JSON body a settlement receiver expects. */
export interface SettlementBody {
  eventId: string;
  slug: string;
  txHash: string;
  chainId: number;
  currency: "USDC";
  grossAmount: string;
  paidTo: WalletAddress;
  payer: WalletAddress | null;
  settledAt: string;
  splits: SettlementSplit[];
}

export const settlementSplitSchema = z
  .object({
    authorId: z.string().min(1),
    wallet: walletSchema,
    amount: z.string().regex(/^\d+$/, "amount must be integer micro-USDC"),
    weight: z.number().int().nonnegative(),
    primary: z.literal(true).optional(),
  })
  .strict();

export const settlementBodySchema = z
  .object({
    eventId: z.string().min(1),
    slug: z.string().min(1),
    txHash: z.string(),
    chainId: z.number().int(),
    currency: z.literal("USDC"),
    grossAmount: z.string().regex(/^\d+$/, "grossAmount must be integer micro-USDC"),
    paidTo: walletSchema,
    payer: walletSchema.nullable(),
    settledAt: z.string(),
    splits: z.array(settlementSplitSchema).min(1),
  })
  .strict()
  .superRefine((b, ctx) => {
    // Money invariant: Σ splits.amount === grossAmount (dust-free).
    const sum = b.splits.reduce((acc, s) => acc + BigInt(s.amount), 0n);
    if (sum !== BigInt(b.grossAmount)) {
      ctx.addIssue({ code: "custom", message: "splits must conserve grossAmount" });
    }
    // Exactly one split is the on-chain recipient.
    if (b.splits.filter((s) => s.primary).length !== 1) {
      ctx.addIssue({ code: "custom", message: "exactly one split must be primary" });
    }
  });
