/**
 * `@naulon/sdk/crawl` — the crawl engine's building blocks, for a front-door that
 * drives its own adapters rather than calling `runCrawl`.
 *
 * A front-door makes two decisions before any adapter runs: is this discovered URL an
 * article (the globs), and how is a feed read (the one XML parser config). Both were
 * implemented once here and then copied verbatim into another front-door, where a
 * divergence changes which URLs a catalog contains — a money difference, not a style
 * one. So they are exported, for the same reason the article-key rule sits behind
 * `@naulon/sdk/slug`: a rule with two spellings has already lost.
 *
 * The same argument applies to everything else a front-door needs — the adapter PORT, the
 * registry that picks one, the guarded fetcher that bounds it, and author→wallet resolution.
 * A host with private adapters implements `SourceAdapter` from here and hands them to
 * `selectAdapter`; it never needs a copy of the engine in order to add a source. What it
 * cannot get from here is the adapters it hasn't written — which is the right shape for a seam.
 *
 * The executable form of the contract lives one level down, at `@naulon/sdk/crawl/testing`, so
 * a test-only surface never lands in a runtime bundle.
 *
 * Separate from the root barrel deliberately. `toArray` and `textOf` are names the
 * publisher contract should not claim at the root, and a consumer that wants the
 * glob matcher should not pull the whole contract to get it.
 */
export { matchGlob, passesGlobs } from "./glob.ts";
export { parseXml, toArray, textOf } from "./xml.ts";

/* The adapter seam: the port, the registry, the adapters this package ships, and the two
   services every front-door needs around them. */
export type {
  AdapterContext,
  AdapterRequirements,
  ArticleCandidate,
  CrawlConfig,
  DiscoveredArticle,
  DiscoveredAuthor,
  Fetcher,
  FetchResult,
  HostCapabilities,
  SourceAdapter,
  SourceAdapterId,
} from "./types.ts";
export { ADAPTERS, adapterById, canRun, selectAdapter } from "./registry.ts";
export { rssAdapter } from "./adapters/rss.ts";
export { sitemapAdapter } from "./adapters/sitemap.ts";
export { wordpressAdapter } from "./adapters/wordpress.ts";
export { makeGuardedFetcher, type GuardedFetcherOpts } from "./fetcher.ts";
export { resolveAuthorWallet, validWallet, type ResolvedAuthor } from "./authors.ts";
