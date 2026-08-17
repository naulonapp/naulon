/**
 * @naulon/sdk — the naulon publisher contract.
 *
 * One source of truth for the two wires a publisher speaks: the credits graph it
 * serves, and the signed webhook it receives when something happens on its account
 * (a settlement landing, an anomaly firing). Runtime deps: `zod` + `node:crypto`
 * only — self-contained, so an external publisher installs one thing. Framework
 * adapters live behind subpath exports (`/next`, `/express`).
 */
export * from "./contract/index.ts";
export * from "./crypto/webhook.ts";
export * from "./crypto/fixture.ts";
export * from "./resolver/types.ts";
export * from "./resolver/http.ts";
export * from "./resolver/fixture.ts";
export * from "./idempotency.ts";
// The crawl engine — shared verbatim by the `naulon-kit crawl` CLI and the
// self-host console's Content tab, so the two front-doors never drift. A third front-door with
// adapters of its own implements the port from `@naulon/sdk/crawl` rather than copying the engine.
export { runCrawl, type CrawlOptions, type CrawlResult } from "./crawl/crawl.ts";
export { makeGuardedFetcher } from "./crawl/fetcher.ts";
export type {
  ArticleCandidate,
  CrawlConfig,
  DiscoveredArticle,
  HostCapabilities,
  SourceAdapterId,
} from "./crawl/types.ts";
// The engine's own building blocks — glob matching and the one feed-reading config —
// are the `@naulon/sdk/crawl` subpath, not this barrel: `toArray`/`textOf` are names
// no publisher contract should claim at the root.
