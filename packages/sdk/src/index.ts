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
// self-host console's Content tab, so the two front-doors never drift.
export { runCrawl, type CrawlOptions, type CrawlResult } from "./crawl/crawl.ts";
export { makeGuardedFetcher } from "./crawl/fetcher.ts";
export type { CrawlConfig, DiscoveredArticle, SourceAdapterId } from "./crawl/types.ts";
// The two decisions a crawl front-door makes before an adapter ever runs: is this
// discovered URL an article (globs), and how is a feed read (the one XML config).
// Exported because a front-door that re-implements either stops agreeing with the
// others about what a catalog contains — which is a money difference, not a style
// one. Same reason the slug rule sits in `./slug`.
export { matchGlob, passesGlobs } from "./crawl/glob.ts";
export { parseXml } from "./crawl/xml.ts";
