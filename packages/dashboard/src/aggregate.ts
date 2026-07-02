/**
 * Turn the raw attributed-event ledger into the shape the dashboard renders:
 * per-author earnings (the traction proof) plus a recent-crossings feed.
 */
import type { AttributedEvent } from "@naulon/shared";

export interface AuthorRow {
  authorId: string;
  wallet: string;
  earned: number;
  events: number;
  lastAt: number;
}

export interface Crossing {
  id: string;
  at: number;
  slug: string;
  kind: string;
  amount: number;
  payer: string;
  split: { authorId: string; amount: number }[];
}

export interface Ledger {
  totalSettled: number;
  eventCount: number;
  authorCount: number;
  authors: AuthorRow[];
  recent: Crossing[];
}

export function aggregate(events: AttributedEvent[], recentLimit = 12): Ledger {
  const byAuthor = new Map<string, AuthorRow>();
  let totalSettled = 0;

  for (const e of events) {
    totalSettled += e.amount;
    for (const p of e.payees) {
      const cut = e.amount * p.share;
      const row = byAuthor.get(p.wallet);
      if (row) {
        row.earned += cut;
        row.events += 1;
        row.lastAt = Math.max(row.lastAt, e.at);
      } else {
        byAuthor.set(p.wallet, {
          authorId: p.authorId,
          wallet: p.wallet,
          earned: cut,
          events: 1,
          lastAt: e.at,
        });
      }
    }
  }

  const authors = [...byAuthor.values()].sort((a, b) => b.earned - a.earned);

  const recent: Crossing[] = [...events]
    .sort((a, b) => b.at - a.at)
    .slice(0, recentLimit)
    .map((e) => ({
      id: e.id,
      at: e.at,
      slug: e.slug,
      kind: e.kind,
      amount: e.amount,
      payer: e.payerAddress,
      split: e.payees.map((p) => ({ authorId: p.authorId, amount: e.amount * p.share })),
    }));

  return {
    totalSettled,
    eventCount: events.length,
    authorCount: authors.length,
    authors,
    recent,
  };
}
