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
import { mergeCredits, type MergeResult } from "./credits-file.ts";
import { adapterById, selectAdapter } from "./registry.ts";
import type { AdapterContext, CrawlConfig, Fetcher, SourceAdapterId } from "./types.ts";

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
}

export interface CrawlResult extends MergeResult {
  /** The adapter that ran, or null when none detected. */
  adapterId: SourceAdapterId | null;
  /** How many articles the adapter discovered (before the merge's custody-free/insert filters). */
  discovered: number;
}

const EMPTY: Omit<MergeResult, "credits"> = { added: [], keptExisting: [], unmapped: [] };

/** Run one crawl pass. Never mutates `existing`; returns the merged map + a summary. */
export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  const ctx: AdapterContext = {
    origin: opts.origin,
    articlePrefixes: opts.articlePrefixes,
    config: opts.config,
    fetch: opts.fetch,
  };

  let adapter;
  if (opts.forceAdapterId) {
    adapter = adapterById(opts.forceAdapterId);
    if (!adapter) throw new Error(`unknown adapter: ${opts.forceAdapterId}`);
  } else {
    adapter = await selectAdapter(ctx);
  }

  if (!adapter) {
    return { credits: { ...opts.existing }, ...EMPTY, adapterId: null, discovered: 0 };
  }

  const discovered = await adapter.discover(ctx);
  const merged = mergeCredits(opts.existing, discovered, opts.config);
  return { ...merged, adapterId: adapter.id, discovered: discovered.length };
}
