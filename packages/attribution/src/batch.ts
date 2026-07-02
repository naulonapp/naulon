/**
 * Batching — turn a stream of sub-cent attributed events into a small number of
 * payouts, one per author wallet. A single citation might owe an author
 * $0.003333; settling that alone is wasteful. We accrue per wallet across many
 * events and only cut a payout once it clears a minimum, carrying the rest.
 *
 * The unit of settlement is a CUT: one author's share of one event, computed
 * once, dust-free. Tracking settlement per cut (not per event) is what lets a
 * co-author whose share is still below the minimum stay pending while their
 * co-author — over the threshold — gets paid. Pure and deterministic.
 */
import type { AttributedEvent } from "@naulon/shared";

const MICRO = 1_000_000;

/** One author's share of one event, in integer micro-USDC. */
export interface Cut {
  eventId: string;
  authorId: string;
  wallet: string;
  micro: number;
}

export interface Payout {
  authorId: string;
  wallet: string;
  amountUsdc: number;
  /** The events this payout settles — for marking (event,wallet) settled once. */
  eventIds: string[];
}

export interface BatchResult {
  /** Wallets that cleared the minimum — ready to settle now. */
  payouts: Payout[];
  /** Wallets still accruing below the minimum — carried to the next pass. */
  deferred: Payout[];
}

/**
 * Expand events into per-author cuts. Each event's amount is split across its
 * payees dust-free: floor each share, then hand the rounding remainder to the
 * largest share so the cuts sum exactly to the event amount.
 */
export function expandCuts(events: AttributedEvent[]): Cut[] {
  const cuts: Cut[] = [];
  for (const e of events) {
    const totalMicro = Math.round(e.amount * MICRO);
    const parts = e.payees.map((p) => ({
      authorId: p.authorId,
      wallet: p.wallet as string,
      micro: Math.floor(totalMicro * p.share),
    }));
    let remainder = totalMicro - parts.reduce((s, c) => s + c.micro, 0);
    [...parts]
      .sort((a, b) => b.micro - a.micro)
      .forEach((part) => {
        if (remainder-- > 0) part.micro += 1;
      });
    for (const part of parts) cuts.push({ eventId: e.id, ...part });
  }
  return cuts;
}

/** Accrue cuts per wallet, then partition by the minimum payout. */
export function batchCuts(cuts: Cut[], minPayoutUsdc: number): BatchResult {
  const byWallet = new Map<string, Payout & { micro: number }>();
  for (const c of cuts) {
    const acc = byWallet.get(c.wallet);
    if (acc) {
      acc.micro += c.micro;
      acc.eventIds.push(c.eventId);
    } else {
      byWallet.set(c.wallet, {
        authorId: c.authorId,
        wallet: c.wallet,
        micro: c.micro,
        amountUsdc: 0,
        eventIds: [c.eventId],
      });
    }
  }

  const minMicro = Math.round(minPayoutUsdc * MICRO);
  const payouts: Payout[] = [];
  const deferred: Payout[] = [];
  for (const a of byWallet.values()) {
    const payout: Payout = {
      authorId: a.authorId,
      wallet: a.wallet,
      amountUsdc: a.micro / MICRO,
      eventIds: a.eventIds,
    };
    (a.micro >= minMicro ? payouts : deferred).push(payout);
  }
  payouts.sort((a, b) => b.amountUsdc - a.amountUsdc);
  return { payouts, deferred };
}

/** Convenience: expand + batch in one call. */
export function batchPayouts(events: AttributedEvent[], minPayoutUsdc: number): BatchResult {
  return batchCuts(expandCuts(events), minPayoutUsdc);
}
