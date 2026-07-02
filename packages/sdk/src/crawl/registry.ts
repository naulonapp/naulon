/**
 * crawl/registry.ts — the adapter registry + auto-detect.
 *
 * `naulon crawl` doesn't make the operator name their platform. It probes every on-origin,
 * no-secret adapter and picks the richest one that detects — WordPress (real author objects)
 * over RSS (free-text authors) over sitemap (URLs only). Ties break by `rank`, highest wins.
 * The two feed fallbacks (rss/sitemap) mean nearly any site yields at least a slug catalog.
 */
import type { AdapterContext, SourceAdapter } from "./types.ts";
import { rssAdapter } from "./adapters/rss.ts";
import { sitemapAdapter } from "./adapters/sitemap.ts";
import { wordpressAdapter } from "./adapters/wordpress.ts";

/** All public on-origin adapters, richest first. */
export const ADAPTERS: readonly SourceAdapter[] = [wordpressAdapter, rssAdapter, sitemapAdapter];

/** The adapter to force by id, or undefined for auto-detect. */
export function adapterById(id: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/** Probe origin with every adapter (highest rank first) and return the first that detects,
 *  or null when none do. Each `detect` uses only the guarded fetch and never throws on "no". */
export async function selectAdapter(ctx: AdapterContext): Promise<SourceAdapter | null> {
  for (const adapter of [...ADAPTERS].sort((a, b) => b.rank - a.rank)) {
    if (await adapter.detect(ctx)) return adapter;
  }
  return null;
}
