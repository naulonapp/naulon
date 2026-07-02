/**
 * Attribution-as-settlement: turn an article's credits graph into a flat list
 * of (wallet, share) payees. Co-authors can be composites that re-split among
 * their own members, so resolution is recursive. Shares always sum to 1.
 *
 * This is the "recursive co-author splits read from the credits graph" that the
 * innovation axis rewards — the payout rule is the attribution metadata itself.
 */
import type { ArticleCredits, AuthorShare, Contributor, WalletAddress } from "./types.ts";
import { walletAddress } from "./types.ts";

const EPSILON = 1e-9;

/**
 * Resolve a credits graph into normalized author shares.
 *
 * @param parentShare the fraction of the whole toll flowing into this subtree
 *                    (1 at the root).
 */
function resolveContributors(contributors: Contributor[], parentShare: number): AuthorShare[] {
  const totalWeight = contributors.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  if (totalWeight <= 0) {
    throw new Error("contributor weights sum to zero — cannot split");
  }

  const out: AuthorShare[] = [];
  for (const c of contributors) {
    const localShare = ((c.weight ?? 1) / totalWeight) * parentShare;

    if (c.members && c.members.length > 0) {
      // Composite contributor: recurse, passing down its slice of the toll.
      out.push(...resolveContributors(c.members, localShare));
    } else if (c.wallet) {
      out.push({ authorId: c.authorId, wallet: c.wallet, share: localShare });
    } else {
      throw new Error(`contributor ${c.authorId} has neither wallet nor members`);
    }
  }
  return out;
}

/**
 * Flatten an article's credits into payees. The same author appearing in
 * multiple subtrees is merged into a single payee (shares added) so settlement
 * is one transfer per wallet, not one per graph edge.
 */
export function resolvePayees(credits: ArticleCredits): AuthorShare[] {
  const raw = resolveContributors(credits.contributors, 1);

  const byWallet = new Map<WalletAddress, AuthorShare>();
  for (const r of raw) {
    const existing = byWallet.get(r.wallet);
    if (existing) {
      existing.share += r.share;
    } else {
      byWallet.set(r.wallet, { ...r });
    }
  }

  const merged = [...byWallet.values()];
  const sum = merged.reduce((s, p) => s + p.share, 0);
  if (Math.abs(sum - 1) > EPSILON) {
    throw new Error(`shares sum to ${sum}, expected 1 — credits graph is malformed`);
  }
  return merged;
}

/**
 * Tie-break for choosing the single on-chain recipient when two payees hold an
 * equal top share. `"wallet"` (default) breaks ties lexicographically by address,
 * so the recipient is a pure function of *who is credited* — independent of the
 * order the credits graph happened to list them in (a reordered or swapped credits
 * endpoint can't change who receives the on-chain leg). `"input"` keeps the
 * credits-graph order (stable sort), matching the pre-config behavior.
 */
export type TieBreak = "wallet" | "input";

/**
 * The single on-chain recipient for a toll: the highest-share payee. x402 settles
 * to one `payTo`, and the settlement record flags this same wallet `primary`, so
 * the on-chain leg and the recorded split MUST agree on it. This is the one source
 * of that choice — imported by the x402 requirement builder and the settlement-body
 * builder rather than computed twice. Throws on an empty payee list: a tolled event
 * always has ≥1 payee, so empty is a malformed call, not a routing edge to paper over.
 */
export function primaryPayee(payees: AuthorShare[], tieBreak: TieBreak = "wallet"): WalletAddress {
  if (payees.length === 0) {
    throw new Error("no payees — cannot resolve a primary on-chain recipient");
  }
  const sorted = [...payees].sort((a, b) => {
    if (b.share !== a.share) return b.share - a.share;
    if (tieBreak === "wallet") return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
    return 0; // "input": stable sort preserves the credits-graph order
  });
  return sorted[0]!.wallet;
}

const MICRO = 1_000_000; // USDC has 6 decimals

/** Integer micro-USDC allocation for one payee — the dust-free unit of truth. */
export interface MicroAllocation {
  wallet: WalletAddress;
  authorId: string;
  micro: number;
}

/**
 * Split an integer micro-USDC total across payees by share. Distributes whole
 * micro units and hands any rounding remainder to the largest-share payee(s),
 * so `Σ micro === totalMicro` exactly — no dust created or lost. This is the
 * money-truth core: callers that need floats wrap it (splitAmount); callers
 * that report integer micro-units to a publisher (settlementEmit) use it raw,
 * never re-multiplying a float back up (which could break a strict sum check).
 */
export function splitMicro(totalMicro: number, payees: AuthorShare[]): MicroAllocation[] {
  const allocations = payees.map((p) => ({
    wallet: p.wallet,
    authorId: p.authorId,
    micro: Math.floor(totalMicro * p.share),
  }));

  const assigned = allocations.reduce((s, a) => s + a.micro, 0);
  let remainder = totalMicro - assigned;

  // Hand the rounding remainder to the largest-share payee(s), deterministically.
  const order = [...allocations].sort((a, b) => b.micro - a.micro);
  let i = 0;
  while (remainder > 0 && order.length > 0) {
    order[i % order.length]!.micro += 1;
    remainder--;
    i++;
  }
  return allocations;
}

/**
 * Split a concrete toll amount across payees. Distributes whole micro-USDC
 * units (6 decimals) and assigns any rounding remainder to the largest payee,
 * so the sum of payouts exactly equals the toll — no dust created or lost.
 */
export function splitAmount(
  amountUsdc: number,
  payees: AuthorShare[],
): { wallet: WalletAddress; authorId: string; amountUsdc: number }[] {
  return splitMicro(Math.round(amountUsdc * MICRO), payees).map((a) => ({
    wallet: a.wallet,
    authorId: a.authorId,
    amountUsdc: a.micro / MICRO,
  }));
}

/**
 * A custody-free split of the author price into on-chain settlement legs: ONE
 * primary leg (settled synchronously at the gate — it gates the content) plus one
 * deferred leg per OTHER co-author. Every leg is a DIRECT buyer→author transfer, so
 * no wallet ever receives money owed to a different author — the lead is never a
 * custodian of a co-author's cut (the custody-free / money-transmitter line).
 */
export interface AuthorLegSplit {
  /** The highest-share payee — recipient of the synchronous, content-gating leg. */
  primaryPayTo: WalletAddress;
  /** The primary author's cut. Atomic micro-USDC, integer string. */
  primaryAmountMicro: string;
  /** One deferred leg per other co-author (a cut that floors to 0 micro is dropped). */
  coauthorLegs: { payTo: WalletAddress; amountMicro: string }[];
}

/**
 * Split `atomicPrice` (integer micro-USDC) across `payees` into legs for
 * split-at-source on-chain settlement. Reuses `splitMicro` so Σ(every leg) ===
 * atomicPrice EXACTLY (no dust created or lost) AND the leg amounts match the
 * earnings-ledger split byte-for-byte — so a co-author's on-chain *paid* equals
 * their ledger *owed*, and reconciliation never shows phantom drift. The primary is
 * `primaryPayee`, the same wallet the requirement builder and the settlement record
 * already agree on. A single payee yields no co-author legs and a primary leg of the
 * whole price (the stock single-author toll). A co-author cut that floors to 0 micro
 * is dropped — a 0-amount transfer is meaningless and the facilitator would reject
 * it; the sum still holds because `splitMicro` handed those units to the primary.
 */
export function splitAuthorLegs(
  payees: AuthorShare[],
  atomicPrice: number,
  tieBreak: TieBreak = "wallet",
): AuthorLegSplit {
  const primary = primaryPayee(payees, tieBreak);
  const allocations = splitMicro(atomicPrice, payees);
  let primaryAmountMicro = "0";
  const coauthorLegs: { payTo: WalletAddress; amountMicro: string }[] = [];
  for (const a of allocations) {
    if (a.wallet === primary) {
      primaryAmountMicro = String(a.micro);
    } else if (a.micro > 0) {
      coauthorLegs.push({ payTo: a.wallet, amountMicro: String(a.micro) });
    }
  }
  return { primaryPayTo: primary, primaryAmountMicro, coauthorLegs };
}

/** Convenience for tests / fixtures: build a leaf contributor. */
export function author(authorId: string, wallet: string, weight?: number): Contributor {
  return { authorId, wallet: walletAddress(wallet), weight };
}
