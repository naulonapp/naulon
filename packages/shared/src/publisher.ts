/**
 * The publisher-resolution seam.
 *
 * One `PublisherConfig` is everything the gate needs to serve a request for the
 * protected publisher: where to proxy, what to charge, who to pay, how to identify
 * itself when it signs receipts, and the secret it uses to report earnings back.
 *
 * A `PublisherResolver` maps the gate's inbound `Host` to that config. The gate core
 * is single-tenant: the reference resolver (`envPublisherResolver`, in the tollgate
 * package) builds one publisher from env and answers EVERY host with it. The
 * resolver is an interface only so a downstream service can front a different
 * publisher by injecting its own — without forking this core. Dependency points
 * one way: a resolver impl may depend on this interface; this interface depends on
 * nothing about how the config is sourced.
 */
import type { CreditsResolver, TollKind, Usdc, WalletAddress } from "./types.ts";

/**
 * A settlement leg beyond the primary author payment — a secondary, direct
 * buyer→recipient transfer attached to a toll. Each leg settles as its OWN x402
 * authorization (its own `payTo`, `amount`, nonce): never pooled, never routed
 * through a gate-held wallet, and **additive** — attaching a leg never reduces the
 * author's amount. The protocol assigns `role` no meaning; it is an opaque label
 * the ledger and dashboards group by (e.g. a co-author split, or a downstream
 * resolver's own secondary payee). The single-tenant core attaches none.
 */
export interface PayoutLeg {
  /** Opaque grouping label for the ledger/dashboard. No protocol meaning. */
  role: string;
  /** Direct recipient of this leg — a distinct buyer→payTo transfer. */
  payTo: WalletAddress;
  /** Atomic micro-USDC, integer string. Added on top of the author price. */
  amount: string;
}

/**
 * Per-publisher crawler policy — the tri-state surface a control plane stores.
 * UA fragments, matched case-insensitively as substrings (same mechanics as
 * `seoAllowlist`). Everything unlisted is CHARGED (the stock toll — absence of
 * this field is byte-identical to today). Fragments are spoofable; verified
 * crawler identity (Web Bot Auth) is a later hardening that swaps the matcher,
 * not this shape.
 */
export interface CrawlerPolicy {
  /** Fragments that read FREE. Merged with the deprecated `seoAllowlist`. */
  allow: string[];
  /**
   * Fragments REFUSED outright on gateable routes — 403 even if the caller
   * presents payment. Checked before classification, so payment intent can
   * never buy past a block. Wins over `allow` on overlap (fail-safe).
   */
  block: string[];
  /**
   * Fragments the publisher explicitly CHARGES. The classifier already tolls
   * agents it recognizes (known-agent UA or declared intent); this list extends
   * that recognition to crawlers the conservative default would let read free
   * (browser-shaped or ambiguous UAs). Precedence: block > allow > charge.
   * Absent → recognition is the classifier's default set, unchanged.
   */
  charge?: string[];
}

export interface PublisherConfig {
  /**
   * Stable identifier for this publisher; tags attributed events and logs. The
   * single-tenant default uses `"default"`.
   */
  id: string;
  /** The publisher origin the gate reverse-proxies article requests to. */
  originUrl: string;
  /**
   * Path prefixes (no leading slash, e.g. `["essays", "posts"]`) whose articles
   * are gateable. A request outside every prefix passes straight through, free.
   */
  articlePrefixes: string[];
  /**
   * Base price for a single read, in whole USDC. A citation is priced up from
   * this (see the tollgate's `quote`). Branded `Usdc` so it can't be mixed with a
   * raw number in money math.
   */
  price: Usdc;
  /**
   * Citation price as a multiple of `price` (a citation has downstream reach, so
   * it's typically priced up). Both kinds resolve to the same payees; only the
   * amount differs. 1 prices a citation the same as a read. The single-tenant
   * default sources this from `CITATION_MULTIPLIER`.
   */
  citationMultiplier: number;
  /**
   * Slug → credits graph: who gets paid for this article, and in what shares.
   * THE publisher-agnostic seam (see `CreditsResolver`). An HTTP API, a static
   * fixture, or a database — the gate doesn't care.
   */
  credits: CreditsResolver;
  /**
   * issuer === audience for Citation License Tokens minted on this publisher's
   * behalf (e.g. `naulon:<host>`). Scoping licenses to the publisher identity is
   * what stops a receipt minted for one publisher from unlocking another.
   */
  licenseIdentity: string;
  /**
   * HMAC secret for the settlement emit to this publisher's earnings ledger.
   * Undefined leaves the emit dark — the gate still tolls and serves; it just
   * doesn't report earnings. (Keeps the no-creds mock loop working, per the hard
   * rule that the loop must run with no secrets.)
   */
  settlementSecret?: string;
  /**
   * Verified search / discovery crawler UA fragments that read FREE for this
   * publisher — the SEO allowlist. A request whose user-agent contains one of
   * these is classified human (a discovery read), so a publisher's indexing is
   * never tolled into a deindex. Honored by `classify` ahead of the known-agent
   * list, matched case-insensitively. Undefined leaves only the classifier's
   * global defaults in effect; the single-tenant resolver leaves it unset.
   */
  seoAllowlist?: string[];
  /**
   * Tri-state crawler policy (allow / charge-by-default / block). Unset — the
   * single-tenant default — leaves only `seoAllowlist` + classifier defaults in
   * effect, byte-identical to before this field existed.
   */
  crawlerPolicy?: CrawlerPolicy;
  /**
   * Optional hook: additional settlement legs for a priced toll, beyond the author
   * payment. Given the resolved `price` (whole USDC) and `kind`, return any extra
   * direct buyer→recipient legs to settle alongside the author. Each is additive
   * (the author leg is unaffected) and settled as its own authorization. Leaving
   * this unset — the single-tenant default — yields no extra legs, so the 402 and
   * the settle path are byte-identical to a plain single-author toll. A downstream
   * resolver (e.g. a multi-tenant control plane charging a secondary fee) populates
   * it; the amount math (flat, percentage, tiered, capped — whatever) lives entirely
   * in that resolver, never in this core.
   */
  extraLegs?: (price: Usdc, kind: TollKind) => PayoutLeg[];
  /**
   * Pay co-authors directly on-chain (split-at-source) instead of routing the whole
   * toll to the primary author. OFF by default (and irrelevant for a single-author
   * article): the author leg settles the FULL price to the highest-share payee and
   * the rest of the co-author split is recorded on the event for the publisher to
   * reconcile off-protocol — the stock behavior, byte-identical on the wire.
   *
   * When ON and an article has >1 payee, the gate reduces the primary's synchronous
   * (content-gating) leg to the primary's OWN share and emits one DEFERRED leg per
   * other co-author — each a direct buyer→co-author transfer drained on-chain like
   * any extra leg. The buyer's total is unchanged (the price is DIVIDED, not added
   * to); only the recipients change. This keeps a genuinely multi-author payout
   * custody-free: no author ever holds another author's cut. Opt-in because some
   * publishers (a publication paying its writers off-protocol) want the single
   * recipient; the credits graph decides who, this flag decides whether on-chain.
   */
  coauthorSplit?: boolean;
  /**
   * Optional hook: the reconciliation id to stamp into the on-chain `Memo` for a
   * priced toll (Arc only). Given the article `slug` and `kind`, return the id that
   * ties this settlement to a citation / license for off-chain reconciliation —
   * carried straight onto `Quote.memoId`, then keccak256'd to the indexed `bytes32`
   * lookup key on settle (see the tollgate's `toMemoId`). Return `undefined` (or
   * leave the hook unset) to stamp nothing: the settle path falls back to the
   * authorization nonce and is byte-identical to the stock Gateway toll, so the
   * single-tenant default is unaffected. The open-core gate never INVENTS an id —
   * a downstream control plane owns the format,
   * exactly like `extraLegs` owns the secondary-leg math.
   */
  memoId?: (ctx: { slug: string; kind: TollKind }) => string | undefined;
  /**
   * Publisher is paused (e.g. a billing lapse upstream) — serve the origin straight
   * through, FREE and untolled, instead of darking the site. Suspension must never
   * turn a live publisher's readers away with an error; the gate simply stops
   * earning until it's lifted. A resolver that has no paused state leaves this unset
   * (false), and the gate tolls normally. Distinct from an UNKNOWN host (resolver
   * returns undefined → the gate's not-served response): a known-but-paused
   * publisher still has an origin to serve.
   */
  suspended?: boolean;
}

export interface PublisherResolver {
  /**
   * Resolve the gate's inbound `Host` to the publisher it fronts. The
   * single-tenant default ignores `host` and returns its one config for every
   * request; a DB-backed impl looks the host up and may cache. Return `undefined`
   * for a host this resolver does not recognize — the gate decides how to respond
   * to an unknown host (it must not leak another publisher's config or misroute).
   */
  resolve(host: string): Promise<PublisherConfig | undefined>;
}
