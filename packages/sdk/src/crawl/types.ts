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
 * The adapters SHIPPED here are on-origin and no-secret (`rss`, `sitemap`, `wordpress`). Keyed
 * sources, LLM enrichment and a review queue belong to an operated pipeline, not to this package
 * — but the CONTRACT for them lives here anyway, as `AdapterRequirements`/`HostCapabilities`.
 * That is deliberate: a host with private adapters implements this interface instead of forking
 * it, and this package's own front-door grants nothing, so it cannot run one by accident.
 */

/* ── the guarded network seam ─────────────────────────────────────────────────── */

/** The minimal response an adapter consumes — a subset of the DOM `Response`, so the real
 *  node-http path and a plain test fake both satisfy it. */
export interface FetchResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * Response headers, lower-cased, multi-values joined with `, `.
   *
   * Optional because a hand-written fake in a test has no reason to carry them, and every adapter
   * that shipped before RSL discovery reads only the body. It exists for the one discovery channel
   * that lives nowhere else: RSL's `Link: <…>; rel="license"; type="application/rsl+xml"`.
   */
  headers?: Record<string, string>;
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

/** One article an adapter found on the verified origin — everything EXCEPT the slug.
 *
 *  The slug is deliberately absent. It is the gate's credits key and must equal what
 *  `slugFromPath` derives from the same URL, so deriving it is an ORCHESTRATOR concern, not an
 *  adapter one: `runCrawl` assigns it once, after `articlePrefixes` are known. An adapter that
 *  derived its own could emit a key the gate cannot reproduce — an article that never tolls —
 *  and nothing downstream would notice. Not being able to say it is the point.
 *
 *  Catalog plane only — no money here, ever. */
export interface ArticleCandidate {
  /** Canonical article URL on the verified origin. */
  url: string;
  title: string;
  /** One-line teaser the SOURCE states (RSS `<description>` / Atom `<summary>`), tag-stripped
   *  and capped. The publisher's own words, so a catalog never depends on generated prose.
   *  Undefined when the source states none. */
  summary?: string;
  /** Feed-stated authors (may be empty — then resolution falls to `defaultWallet`). */
  authors: DiscoveredAuthor[];
  /** ISO-8601 publish timestamp the source states, when present. */
  publishedAt?: string;
  /** The slug the SOURCE claims (some catalog endpoints state one). ADVISORY only — the
   *  orchestrator still derives the real key from `url` and this never overrides it. */
  statedSlug?: string;
}

/** A candidate the orchestrator has keyed: `slug = deriveSlug(url, articlePrefixes)`. This is
 *  what the merge and the credits file consume — nothing else may construct it. */
export interface DiscoveredArticle extends ArticleCandidate {
  /** The gate's credits key — the URL path slug, derived per `articlePrefixes`. */
  slug: string;
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
  /** The file extensions the publisher opted in to tolling (`gateScope.includeExtensions` —
   *  lowercase, dotless). Adapters that can enumerate a site's FILES as well as its posts discover
   *  them only for these; empty or absent ⇒ articles only, which is the historical behaviour.
   *
   *  It is the same list the gate reads, for the same reason the slug derivation already carries
   *  it: a file the gate tolls and the crawl never discovered has no credits, so it serves free
   *  forever while every dashboard reports the site as configured. Nothing warns about that. */
  includeExtensions?: readonly string[];
}

/* ── capabilities: what an adapter needs, and what a host can give ────────────── */

/**
 * What an adapter needs from its HOST beyond the guarded origin fetch, declared up front.
 *
 * This is the extension seam. Adapters that need nothing (every adapter in this package)
 * declare nothing and run anywhere. An adapter that needs a publisher API key, or that must
 * reach a platform API hosted off the publisher's origin, says so HERE — and a host that
 * cannot grant it never runs that adapter (`canRun`). That keeps two properties at once:
 *
 *  - a front-door with no secret store (this package's `naulon crawl` CLI) is structurally
 *    incapable of selecting a keyed adapter — it is not a convention, it is a filter; and
 *  - `offOrigin` is a FIXED, declared, auditable host allowlist rather than per-adapter
 *    discretion, so "adapters only reach the verified origin" survives contact with the one
 *    platform whose API genuinely lives elsewhere.
 */
export interface AdapterRequirements {
  /** Needs a per-publisher API secret (a Content-API key and the like). */
  readonly secret?: true;
  /** Needs to reach these EXACT hosts off the verified origin. A fixed allowlist the adapter
   *  hard-codes — never a value derived from user input, or the SSRF guard is theatre. */
  readonly offOrigin?: readonly string[];
}

/** What a host is able to provide. A host grants what it has; the registry refuses any adapter
 *  whose `requires` it cannot satisfy, so an unsatisfiable adapter is never even probed. */
export interface HostCapabilities {
  /** The per-publisher secret, when the host holds one. Write-only upstream; never logged. */
  readonly secret?: string;
  /** A fetcher bound to a FIXED host allowlist. Deliberately distinct from `ctx.fetch`: the
   *  origin guard must never be relaxed to a user-controlled host, so off-origin platform calls
   *  go through this narrowly-scoped seam instead. */
  readonly offOriginFetch?: Fetcher;
}

/** Everything an adapter may touch: the verified origin, the human policy, the guarded fetch,
 *  and whatever the host granted. An adapter that reaches outside `ctx.fetch` /
 *  `ctx.capabilities.offOriginFetch` breaks the SSRF guarantee. */
export interface AdapterContext {
  /** The verified origin `scheme://host[:port]` — the ONLY host `ctx.fetch` connects to. */
  origin: string;
  /** Gateable path prefixes (no leading slash). The orchestrator derives the slug from these;
   *  an adapter may read them to shape its own probing, but never to key an article. */
  articlePrefixes: string[];
  config: CrawlConfig;
  fetch: Fetcher;
  /** What the host granted. Absent ⇒ granted nothing, which is this package's own case. */
  capabilities?: HostCapabilities;
}

/** The adapter ids this package ships — on-origin, no-secret sources only. A host with more
 *  adapters parameterizes `SourceAdapter` with its own wider id union. */
export type SourceAdapterId = "rss" | "sitemap" | "wordpress";

/**
 * A source connector: one file per platform. The registry picks the richest adapter that both
 * `canRun` (its `requires` are satisfied) and `detect`s; `rss`/`sitemap` are the always-available
 * fallbacks (lowest rank).
 *
 * Generic in the id so a host with its own sources — a hosted pipeline, a private connector —
 * implements THIS interface rather than copying it. That is the whole point of the seam: one
 * owner for the contract, implementations wherever they belong.
 */
export interface SourceAdapter<Id extends string = SourceAdapterId> {
  readonly id: Id;
  /** Richness rank — the registry prefers the highest detected. Real author objects (WordPress)
   *  outrank feed parsing (rss), which outranks pure URL discovery (sitemap). */
  readonly rank: number;
  /** True when every URL this source returns is a real article (a feed or API listing), as
   *  opposed to every URL on the site (a sitemap). A host may infer article prefixes from a
   *  curated source's URLs; it must not from an uncurated one. */
  readonly curated?: boolean;
  /** True when this source can enumerate a site's non-HTML FILES, not only its posts, given a
   *  non-empty `config.includeExtensions`. Declared rather than inferred because a publisher who
   *  opts `pdf` in to the toll needs to be told, on the page where they tick it, whether their
   *  catalogue can find one — and the alternative to declaring it is a hard-coded list of adapter
   *  ids somewhere in a UI, which is drift waiting to happen. */
  readonly files?: boolean;
  /** What this adapter needs from the host. Absent ⇒ nothing beyond the guarded origin fetch. */
  readonly requires?: AdapterRequirements;
  /** Cheap probe: could this adapter discover THIS origin? MUST use only the granted fetchers.
   *  Never throws on a normal "no" — returns false. */
  detect(ctx: AdapterContext): Promise<boolean>;
  /** Discover the catalog. MUST hit only the verified origin (or a declared `offOrigin` host).
   *  Returns candidates — the orchestrator assigns slugs. */
  discover(ctx: AdapterContext): Promise<ArticleCandidate[]>;
}
