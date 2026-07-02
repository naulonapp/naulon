/**
 * crawl/authors.ts — author → wallet resolution.
 *
 * The single point where the catalog plane (a feed author STRING) meets the money plane (a
 * payTo). It is DETERMINISTIC and never invents an address — the load-bearing custody-free
 * invariant. Resolution order, exactly:
 *   1. the primary author's feed string → `authorWalletMap[name]` (human-supplied)
 *   2. else → `defaultWallet` (human-supplied fallback)
 *   3. else → null → the article is UNMAPPED: reported to the operator, never written to a guess.
 *
 * A mapped value is re-checked against the EVM address shape: a malformed entry resolves as if
 * absent, rather than tolling to a bad address.
 */
import type { CrawlConfig, DiscoveredArticle } from "./types.ts";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface ResolvedAuthor {
  /** The primary author's feed string (the map key), or null when the source stated none. */
  author: string | null;
  /** The human-mapped payTo, or null when unmapped (→ reported, never auto-tolled). */
  wallet: string | null;
  /** True when no valid wallet resolved — the "leave it for the human" signal. */
  unmapped: boolean;
}

/** The shared EVM-address gate: returns the address if well-formed, else null. */
export function validWallet(addr: string | undefined): string | null {
  return addr && EVM_ADDRESS.test(addr) ? addr : null;
}

/** Resolve the primary author of a discovered article to a payout wallet, deterministically. */
export function resolveAuthorWallet(article: DiscoveredArticle, config: CrawlConfig): ResolvedAuthor {
  const primary = article.authors[0]?.name?.trim() || null;
  const mapped = primary ? validWallet(config.authorWalletMap[primary]) : null;
  const wallet = mapped ?? validWallet(config.defaultWallet);
  return { author: primary, wallet, unmapped: wallet === null };
}
