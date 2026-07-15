/** Wayfarer domain types — the shapes that flow through discover → … → ground. */
import type { Usdc } from "@naulon/shared";

/** An essay the agent could pay to read, before it has decided anything. */
export interface Candidate {
  slug: string;
  title: string;
  /** Public teaser the agent reads for free to judge relevance. */
  summary: string;
  /**
   * Publisher host this candidate is served from (e.g. `example.com`). Optional:
   * the single-gate pipeline leaves it unset (one configured origin). Multi-gate
   * discovery (the fleet directory) populates it, and the policy engine uses it
   * for domain allow/deny + per-domain caps.
   */
  host?: string;
  /**
   * Canonical URL this candidate is served from — the real link a discovery source
   * (RSS `<link>`, sitemap `<loc>`, catalog/directory `url`) already knows. When
   * present, quote/pay use it VERBATIM. Absent ⇒ the pipeline falls back to
   * `articleUrl(base, slug)` (the single-gate `/essays/<slug>` convention). Carrying
   * the real URL is what lets one buyer pay any publisher's URL shape — `/articles/`,
   * a custom domain, a query string — instead of reconstructing a fixed template.
   */
  url?: string;
  /** Indicative read price (USDC) a fleet catalog may carry. Advisory — the 402 is the truth. */
  priceUsdc?: number;
  /** Indicative citation price (USDC). Advisory — the 402 is the truth. */
  citationPriceUsdc?: number;
}

/** A candidate after the tollgate has quoted a price for it. The author split is
 * the seller's concern (recorded on the event); the buyer only needs the price. */
export interface PricedCandidate extends Candidate {
  price: Usdc;
}

/** A candidate after appraisal — how useful it looks for the topic. */
export interface AppraisedCandidate extends PricedCandidate {
  /** 0..1 estimate of relevance/value to the research topic. */
  relevance: number;
  /** Human-readable justification (shown in the decision log + demo). */
  rationale: string;
}

export type Action = "pay" | "skip" | "cache" | "approve";

/** The agent's verdict on one candidate, with a visible reason. */
export interface Decision {
  slug: string;
  title: string;
  /** Canonical URL carried from the candidate (see `Candidate.url`) so the pay
   *  step targets the real link, not a reconstructed `/essays/<slug>` path. */
  url?: string;
  action: Action;
  reason: string;
  relevance: number;
  price: number;
  /** value density = relevance / price, the ranking key. */
  density: number;
}

/** A source the agent actually obtained (paid or from cache) and can cite. */
export interface Source {
  slug: string;
  title: string;
  content: string;
  paidUsdc: number;
  settlementRef?: string;
  /** Citation License `jti` proving this read was paid for (verifiable at the gate). */
  licenseId?: string;
}

export interface RunResult {
  topic: string;
  budget: number;
  spent: number;
  decisions: Decision[];
  sources: Source[];
  answer: string;
}
