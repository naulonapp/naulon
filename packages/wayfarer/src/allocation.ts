/**
 * Cross-source proportional allocation (BUY-3.2) — a BUYER-side policy.
 *
 * Keryx splits a citation-reward pool across the sources it actually cited,
 * weighted by each source's contribution. Wayfarer pays each source a flat
 * per-article toll; this closes the parity gap as a *policy* on top of those
 * tolls: given a fixed answer-budget, decide how much of it each cited source
 * earned, proportional to its appraised contribution.
 *
 * It computes numbers — it does NOT pay. There is no new settlement primitive;
 * a caller that wants to act on the split reuses the existing per-article toll
 * rail. Money is integer micro-USDC and the split is dust-free (largest-
 * remainder apportionment, same money-truth discipline as shared `splitMicro`,
 * here keyed by source slug rather than payee wallet).
 */

/** One source's share of the answer-budget. */
export interface SourceAllocation {
  slug: string;
  /** Integer micro-USDC of the pool attributed to this source. */
  micro: number;
  /** Normalized 0..1 contribution weight (for display / a citation-reward call). */
  weight: number;
}

/**
 * Allocate `poolMicro` (integer micro-USDC) across `sources` proportional to each
 * source's `contribution`. Negative contributions clamp to zero. When the total
 * contribution is positive, `Σ micro === floor(poolMicro)` exactly — no dust
 * created or lost; the rounding remainder goes to the largest fractional shares.
 * When every contribution is zero (or the list is empty), nothing is allocated
 * (all `micro === 0`) — there is no basis to weight the pool.
 */
export function allocateByContribution(
  sources: readonly { slug: string; contribution: number }[],
  poolMicro: number,
): SourceAllocation[] {
  const weights = sources.map((s) => (s.contribution > 0 ? s.contribution : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return sources.map((s) => ({ slug: s.slug, micro: 0, weight: 0 }));

  const pool = Math.max(0, Math.floor(poolMicro));
  const exact = weights.map((w) => (pool * w) / total);
  const micro = exact.map((e) => Math.floor(e));
  let remainder = pool - micro.reduce((a, b) => a + b, 0);

  // Largest-remainder apportionment: hand each leftover micro-unit to the source
  // with the biggest fractional part (tie → larger weight, then lower index, for
  // determinism). remainder is an integer in [0, sources.length], so this closes
  // the gap exactly without ever over-distributing.
  const byFraction = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e), weight: weights[i]! }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i);
  for (let k = 0; remainder > 0 && k < byFraction.length; k++, remainder--) {
    micro[byFraction[k]!.i]!++;
  }

  return sources.map((s, i) => ({ slug: s.slug, micro: micro[i]!, weight: weights[i]! / total }));
}
