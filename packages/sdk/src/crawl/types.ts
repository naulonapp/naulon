/**
 * crawl/types.ts — the ports for the open-source publisher crawler.
 *
 * `naulon crawl` is a ONE-SHOT drafting aid: it reads a publisher's own origin
 * (no API key) and drafts a `credits.json` so a self-hoster doesn't hand-author
 * one article at a time. It is deliberately the *primitive* form of discovery —
 * the hosted product's continuous, enriched, reviewed, multi-tenant pipeline is a
 * separate thing and stays there. This file is the seam; concrete adapters live
 * beside it and reach the network ONLY through the guarded `Fetcher`.
 *
 * The load-bearing invariant, identical to the hosted crawler: the crawler auto-
 * configs the CATALOG plane only (slugs, titles, author strings). MONEY IS NEVER
 * INFERRED — a `DiscoveredArticle` carries the feed's author STRING, never a wallet.
 * The human-supplied `authorWalletMap` / `defaultWallet` map that string to a payTo;
 * an unmapped author is reported to the operator, never written to a guessed address.
 *
 * On-origin, no-secret adapters ONLY (`rss`, `sitemap`, `wordpress`). Keyed adapters
 * (Ghost/Blogger), LLM enrichment, and a review queue are the operated pipeline — not here.
 */

/* ── the guarded network seam ─────────────────────────────────────────────────── */

/** The minimal response an adapter consumes — a subset of the DOM `Response`, so the real
 *  node-http path and a plain test fake both satisfy it. */
export interface FetchResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The ONLY way an adapter reaches the network. The crawl orchestrator injects an impl that
 *  enforces verified-origin-only + SSRF CIDR block + anti-DNS-rebind (`makeGuardedFetcher`).
 *  Adapters never import `fetch`/`node:http` — that keeps the SSRF guard un-bypassable and the
 *  whole module network-testable with a plain fake. */
export interface Fetcher {
  (url: string, init?: { headers?: Record<string, string> }): Promise<FetchResult>;
}

/* ── what an adapter discovers ────────────────────────────────────────────────── */

/** One author exactly as the feed/API states it. `name` is the raw string used as the
 *  `authorWalletMap` key — catalog data, NEVER a wallet (money is never inferred). */
export interface DiscoveredAuthor {
  name: string;
  /** Platform-native id when exposed (WP author id/slug) — aids stable mapping. */
  externalId?: string;
}

/** One article an adapter found on the verified origin. Catalog plane only — no money here. */
export interface DiscoveredArticle {
  /** The gate's credits key — the URL path slug, derived per `articlePrefixes`. */
  slug: string;
  /** Canonical article URL on the verified origin. */
  url: string;
  title: string;
  /** Feed-stated authors (may be empty — then resolution falls to `defaultWallet`). */
  authors: DiscoveredAuthor[];
  /** ISO-8601 publish timestamp the source states, when present. */
  publishedAt?: string;
}

/** The human-authored crawl policy the adapters read. A subset of the hosted `CrawlConfig`:
 *  no API keys (keyed adapters are hosted-only), no continuous-sweep knobs. */
export interface CrawlConfig {
  /** Explicit feed/sitemap URL, overriding the conventional-path probe. */
  feedUrl?: string;
  /** URL-path globs deciding which discovered URLs are articles (sitemap adapter). */
  includeGlobs: string[];
  excludeGlobs: string[];
  /** author STRING → payTo, human-supplied. Never inferred. */
  authorWalletMap: Record<string, string>;
  /** Fallback payTo when an author is unmapped or the source stated none. Optional —
   *  absent means an unmapped article is reported, not written. */
  defaultWallet?: string;
}

/** Everything an adapter may touch: the verified origin, the human policy, the guarded fetch.
 *  An adapter that reaches outside `ctx.fetch` breaks the SSRF guarantee. */
export interface AdapterContext {
  /** The verified origin `scheme://host[:port]` — the ONLY host `ctx.fetch` connects to. */
  origin: string;
  /** Gateable path prefixes (no leading slash). A slug MUST be derived from these (via
   *  `deriveSlug`) so it matches the gate's credits key exactly. */
  articlePrefixes: string[];
  config: CrawlConfig;
  fetch: Fetcher;
}

/** The public adapter ids — on-origin, no-secret sources only. */
export type SourceAdapterId = "rss" | "sitemap" | "wordpress";

/** A source connector: one file per platform. The registry picks the richest adapter whose
 *  `detect` returns true; `rss`/`sitemap` are the always-available fallbacks (lowest rank). */
export interface SourceAdapter {
  readonly id: SourceAdapterId;
  /** Richness rank — the registry prefers the highest detected. Real author objects (WordPress)
   *  outrank feed parsing (rss), which outranks pure URL discovery (sitemap). */
  readonly rank: number;
  /** Cheap probe: could this adapter discover THIS origin? MUST use only `ctx.fetch`. Never
   *  throws on a normal "no" — returns false. */
  detect(ctx: AdapterContext): Promise<boolean>;
  /** Discover the catalog. MUST hit only the verified origin via `ctx.fetch`. */
  discover(ctx: AdapterContext): Promise<DiscoveredArticle[]>;
}
