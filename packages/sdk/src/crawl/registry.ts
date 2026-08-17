/**
 * crawl/registry.ts — the adapter registry, capability filter + auto-detect.
 *
 * `naulon crawl` doesn't make the operator name their platform. It probes every adapter the host
 * can actually run and picks the richest one that detects — WordPress (real author objects) over
 * RSS (free-text authors) over sitemap (URLs only). Ties break by `rank`, highest wins. The two
 * feed fallbacks mean nearly any site yields at least a slug catalog.
 *
 * Two things are parameterized so a different front-door reuses this instead of copying it:
 * the adapter LIST (a host with its own sources passes its own) and a PREFERRED id (a host whose
 * user already named their platform tries that first, then falls back to rank order — so a wrong
 * answer in a form still crawls rather than silently discovering nothing).
 */
import type { AdapterContext, HostCapabilities, SourceAdapter, SourceAdapterId } from "./types.ts";
import { rssAdapter } from "./adapters/rss.ts";
import { sitemapAdapter } from "./adapters/sitemap.ts";
import { wordpressAdapter } from "./adapters/wordpress.ts";

/** All adapters this package ships, richest first. */
export const ADAPTERS: readonly SourceAdapter[] = [wordpressAdapter, rssAdapter, sitemapAdapter];

/** The adapter to force by id, or undefined for auto-detect. */
export function adapterById(id: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/**
 * Whether a host's grants satisfy an adapter's declared requirements.
 *
 * This is what makes the seam a boundary rather than a comment: an adapter needing a secret or an
 * off-origin host is not merely discouraged in a front-door that has neither — it is filtered out
 * before `detect` is called, so it cannot fetch, cannot log, cannot half-run.
 */
export function canRun(adapter: SourceAdapter<string>, capabilities?: HostCapabilities): boolean {
  const req = adapter.requires;
  if (!req) return true;
  if (req.secret && !capabilities?.secret) return false;
  if (req.offOrigin?.length && !capabilities?.offOriginFetch) return false;
  return true;
}

/**
 * Probe `origin` with every runnable adapter and return the first that detects, or null when
 * none do. Order: the preferred id (when given and runnable), then the rest by rank descending.
 * Each `detect` uses only granted fetchers and never throws on a normal "no".
 */
export async function selectAdapter<Id extends string = SourceAdapterId>(
  ctx: AdapterContext,
  adapters: readonly SourceAdapter<Id>[] = ADAPTERS as readonly SourceAdapter<Id>[],
  preferId?: Id,
): Promise<SourceAdapter<Id> | null> {
  const runnable = adapters.filter((a) => canRun(a, ctx.capabilities));
  const preferred = preferId ? runnable.find((a) => a.id === preferId) : undefined;
  const rest = runnable.filter((a) => a !== preferred).sort((a, b) => b.rank - a.rank);
  for (const adapter of preferred ? [preferred, ...rest] : rest) {
    if (await adapter.detect(ctx)) return adapter;
  }
  return null;
}
