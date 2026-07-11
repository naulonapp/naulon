/**
 * @naulon/sdk — the naulon publisher contract.
 *
 * One source of truth for the credits + settlement wire: the types a publisher
 * produces/consumes, the validators that guard the money-routing boundary, the
 * HMAC sign/verify pair, and the credits resolvers. Runtime deps: `zod` +
 * `node:crypto` only — self-contained, so an external publisher installs one
 * thing. Framework adapters live behind subpath exports (added in a later phase).
 */
export * from "./contract/index.ts";
export * from "./crypto/sign.ts";
export * from "./crypto/verify.ts";
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
