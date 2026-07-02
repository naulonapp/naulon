/**
 * Settlement — OFFLINE SIMULATION ONLY. A Settlement takes batched payouts and
 * returns receipts for the earn → batch → pay-out loop, so the attribution
 * service (index.ts) is exercisable end-to-end with no creds, no chain.
 *
 * THIS IS NOT THE SETTLEMENT OF RECORD, AND MUST NOT BECOME A REAL TRANSFER.
 * Real settlement is custody-free and lives in the tollgate: the buyer signs an
 * EIP-3009 authorization paying the author DIRECTLY, settled inline at toll time
 * (`tollgate/src/x402.ts` — `settleGateway` on Base/Gateway, `settleViaMemo` on
 * Arc) and, for extra legs, by the deferred drain. The operator/relayer only
 * pays gas; it never holds USDC.
 *
 * A `Payout` here carries `{authorId, wallet, amountUsdc}` — it has accrued many
 * buyers' sub-cent cuts into one figure and KEPT NO buyer signature. The only
 * party that could move that amount on-chain is the operator, from funds it first
 * pooled — i.e. custody. That is the money-transmitter pattern the custody-free
 * hard rule (see AGENTS.md) forbids. So this path stays a mock; the custody-free
 * "batch" already exists as the drain, keyed on stored buyer authorizations.
 */
import { getConfig } from "@naulon/shared";
import type { Payout } from "./batch.ts";

export interface Receipt {
  authorId: string;
  wallet: string;
  amountUsdc: number;
  eventIds: string[];
  ref: string;
  at: number;
}

export interface Settlement {
  settle(payouts: Payout[], now: number): Promise<Receipt[]>;
}

export function mockSettlement(): Settlement {
  return {
    async settle(payouts, now) {
      return payouts.map((p, i) => ({
        authorId: p.authorId,
        wallet: p.wallet,
        amountUsdc: p.amountUsdc,
        eventIds: p.eventIds,
        ref: `mock-payout-${now}-${i}`,
        at: now,
      }));
    },
  };
}

/**
 * Always the mock — by design, not by omission. Real funds move custody-free at
 * toll time in the tollgate (buyer→author EIP-3009; see the module header), never
 * through this amount-based batch. The `CIRCLE_API_KEY` guard fails loud so a
 * deploy that has Circle creds can never silently route real settlement through a
 * simulation; it does NOT mean "settlement unimplemented" — it means this is the
 * wrong layer for it. Do not replace this with an operator→author transfer: that
 * would pool funds (custody) and break the money-transmitter-free model.
 */
export function getSettlement(): Settlement {
  if (getConfig().CIRCLE_API_KEY) {
    throw new Error(
      "attribution settlement is an offline simulation, not the settlement of record — " +
        "real settlement is custody-free and inline in the tollgate (buyer→author EIP-3009). " +
        "Unset CIRCLE_API_KEY here; an operator→author batch transfer would pool funds (custody).",
    );
  }
  return mockSettlement();
}
