/**
 * crawl/crawl.ts — the pure crawl orchestrator.
 *
 * Ties the pieces together with NO I/O: pick an adapter (forced or auto-detected), discover
 * the catalog through the injected guarded fetch, and merge into the existing credits map
 * (insert-only, custody-free). The CLI shell (`cli/crawl.ts`) supplies the real guarded
 * fetcher, reads/writes `credits.json`, and prints the summary — this stays testable with a
 * plain fake fetch, the same split as `buildInitPlan` vs the `init` CLI.
 */
import type { ArticleCredits } from "../contract/credits.ts";
import { deriveSlug } from "../contract/slug.ts";
import { mergeCredits, type MergeResult } from "./credits-file.ts";
import { adapterById, selectAdapter } from "./registry.ts";
import type {
  AdapterContext,
  ArticleCandidate,
  CrawlConfig,
  DiscoveredArticle,
  Fetcher,
  HostCapabilities,
  SourceAdapterId,
} from "./types.ts";

export interface CrawlOptions {
  /** The verified origin `scheme://host[:port]`. */
  origin: string;
  /** Gateable path prefixes (no leading slash) — the slug key derivation. */
  articlePrefixes: string[];
  /** The human-authored crawl policy (wallet map, default wallet, globs, feed override). */
  config: CrawlConfig;
  /** The current `credits.json` map (empty `{}` for a first crawl). */
  existing: Record<string, ArticleCredits>;
  /** The guarded fetcher (origin-bound + SSRF-blocked). Injected so tests use a fake. */
  fetch: Fetcher;
  /** Force a specific adapter instead of auto-detecting. */
  forceAdapterId?: SourceAdapterId;
  /** What this front-door can grant an adapter. This package's CLI grants nothing, so a keyed
   *  adapter could not run here even if one were registered. */
  capabilities?: HostCapabilities;
}

export interface CrawlResult extends MergeResult {
  /** The adapter that ran, or null when none detected. */
  adapterId: SourceAdapterId | null;
  /** How many candidates the adapter returned (before keying and the merge's filters). */
  discovered: number;
  /** Candidates dropped because no gateable slug could be derived from their URL — off-prefix
   *  pages a feed happens to list, or a permalink shape the gate cannot key. Reported rather
   *  than silently swallowed: a big number here usually means the wrong `articlePrefixes`. */
  unkeyable: number;
}

/**
 * Key the candidates: `slug = deriveSlug(url, articlePrefixes)`, the ONE place this happens.
 *
 * Candidates with no derivable slug are dropped (counted, not hidden) — the gate could never
 * serve them under any key. Duplicates keep the FIRST occurrence, which matters for sources that
 * list one article under several URLs (a sitemap with paginated or tagged variants).
 */
function keyCandidates(
  candidates: ArticleCandidate[],
  articlePrefixes: string[],
): { articles: DiscoveredArticle[]; unkeyable: number } {
  const articles: DiscoveredArticle[] = [];
  const seen = new Set<string>();
  let unkeyable = 0;
  for (const c of candidates) {
    const slug = c.url ? deriveSlug(c.url, articlePrefixes) : null;
    if (!slug) {
      unkeyable++;
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    articles.push({ ...c, slug });
  }
  return { articles, unkeyable };
}

const EMPTY: Omit<MergeResult, "credits"> = { added: [], keptExisting: [], unmapped: [] };

/** Run one crawl pass. Never mutates `existing`; returns the merged map + a summary. */
export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  const ctx: AdapterContext = {
    origin: opts.origin,
    articlePrefixes: opts.articlePrefixes,
    config: opts.config,
    fetch: opts.fetch,
    capabilities: opts.capabilities,
  };

  let adapter;
  if (opts.forceAdapterId) {
    adapter = adapterById(opts.forceAdapterId);
    if (!adapter) throw new Error(`unknown adapter: ${opts.forceAdapterId}`);
  } else {
    adapter = await selectAdapter(ctx);
  }

  if (!adapter) {
    return { credits: { ...opts.existing }, ...EMPTY, adapterId: null, discovered: 0, unkeyable: 0 };
  }

  const candidates = await adapter.discover(ctx);
  const { articles, unkeyable } = keyCandidates(candidates, opts.articlePrefixes);
  const merged = mergeCredits(opts.existing, articles, opts.config);
  return { ...merged, adapterId: adapter.id, discovered: candidates.length, unkeyable };
}
