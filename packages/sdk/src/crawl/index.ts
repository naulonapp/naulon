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
 * Separate from the root barrel deliberately. `toArray` and `textOf` are names the
 * publisher contract should not claim at the root, and a consumer that wants the
 * glob matcher should not pull the whole contract to get it.
 */
export { matchGlob, passesGlobs } from "./glob.ts";
export { parseXml, toArray, textOf } from "./xml.ts";
export type { Fetcher, FetchResult } from "./types.ts";
