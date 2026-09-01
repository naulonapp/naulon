/**
 * contract/slug.ts — THE article-key rule. One owner, every plane.
 *
 * The slug is the join between the three things that must agree or no toll ever lands:
 * the key the gate derives from a request path, the key a crawler writes into
 * `credits.json` / the catalog, and the key the publisher's credits API answers at.
 * Derive it two ways and you have not got a bug yet — you have got a bug scheduled.
 *
 * It lives in `@naulon/sdk` because that is the BOTTOM of the package graph
 * (sdk → shared → enforce → tollgate): the only place every consumer can reach without
 * inverting a dependency. It is exported from the zero-dependency `@naulon/sdk/slug`
 * subpath, so the gate kernel and the in-app middleware pull the rule without pulling
 * the crawl engine's XML parser.
 *
 * WHY THIS FILE EXISTS AT ALL (2026-08-17). The rule had five copies — two in
 * `enforce/decide.ts`, one in `sdk/crawl/slug.ts`, and two more in the private control
 * plane's crawler. Exactly one of them wrapped `decodeURIComponent`. The other four
 * threw `URIError: URI malformed` on any path carrying a stray `%`, which a raw
 * `GET /essays/100%` delivers verbatim to the handler — so the gate answered 500 on a
 * request that should have been a free passthrough, and one such URL in a sitemap
 * aborted a whole tenant's crawl. That is the cost of a rule with more than one owner.
 */

/** Escape a string for use as a literal inside a RegExp. Publisher-supplied prefixes are
 *  interpolated below, so a raw `new RegExp(prefix)` would be a regex-injection / ReDoS hole. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiled article-path matchers, memoized per prefix set — a gate sees a handful of
// distinct prefix configs, not one per request, and a crawl sweep matches one config
// against thousands of URLs. Either way the regex is compiled once.
const articleReCache = new Map<string, RegExp>();
function articleRe(prefixes: string[]): RegExp {
  const key = prefixes.join("|");
  let re = articleReCache.get(key);
  if (!re) {
    re = new RegExp(`^/(?:${prefixes.map(escapeRe).join("|")})/([^/?#]+)`);
    articleReCache.set(key, re);
  }
  return re;
}

/** Gate control routes are never articles, whatever prefixes a publisher configures. */
function isControlRoute(pathname: string): boolean {
  // Repeated leading slashes are collapsed FIRST. Hono routes `//.well-known/naulon-jwks.json`
  // to the catch-all rather than the JWKS handler, so a raw `startsWith` let that spelling reach
  // the toll — free before `includeExtensions`, chargeable after it, which is a regression a
  // client joining a base URL ending in `/` produces by accident.
  const p = pathname.replace(/^\/+/, "/");
  return p.startsWith("/.well-known/") || p.startsWith("/licenses/");
}

/**
 * Percent-decode an article key, or `null` when it cannot be decoded.
 *
 * A path segment that is not valid percent-encoding (`/essays/100%`, `%zz`) has no
 * article key: `decodeURIComponent` throws on it, and the two honest answers are "the
 * raw bytes" or "not an article". We take the second, because it is the only one that
 * keeps the planes in step — the gate passes such a request through FREE and the
 * crawler stages nothing for it, so there is no row keyed by something the other side
 * would have spelled differently. Consistent with the standing conservative bias: when
 * in doubt, do not toll.
 */
export function decodeSlug(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Article slug from a request path like `/essays/on-stillness` (a trailing query/hash is
 * tolerated), using the publisher's article prefixes. Returns the decoded slug, or `null`
 * when the path is not a gateable article — no prefix matches, it is a gate control route,
 * there are no usable prefixes, or the key does not decode.
 */
export function slugFromPath(path: string, prefixes: string[]): string | null {
  if (isControlRoute(path)) return null;
  // Drop empty prefixes — an empty alternative would make the regex match `//x` or any
  // leading slash and gate routes the publisher never opted in.
  const clean = prefixes.filter(Boolean);
  if (clean.length === 0) return null;
  const m = path.match(articleRe(clean));
  return m ? decodeSlug(m[1]!) : null;
}

const STATIC_EXT_RE = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|txt|xml|json)$/i;

/**
 * The ORIGINAL root-anchored discovery matcher. Kept, so nothing that was free before
 * can become tolled by the name-shaped rules below — the union is strictly more free.
 */
const DISCOVERY_ROOT_RE = /^\/(robots\.txt|sitemap[^/]*|rss[^/]*|atom[^/]*|feed[^/]*|favicon\.ico)$/i;

/**
 * Discovery by FILENAME, at any depth — because the root-anchored rule above was never
 * enough and `includeExtensions` is what made that expensive.
 *
 * Measured against the shipped root-only matcher with `xml`/`txt` opted in: `/sitemap.xml`
 * was free but `/wp-sitemap.xml` (WordPress core since 5.5), `/wp-sitemap-posts-post-1.xml`,
 * `/post-sitemap.xml` (Yoast), `/index.xml` (Hugo's feed), `/en/sitemap.xml` and
 * `/blog/feed.xml` all TOLLED. Paywalling a sitemap starves the catalog agents buy from —
 * the one outcome site mode exists to refuse — and it does it to the largest CMS on the web.
 *
 * These match the LAST path segment, so `/papers/feedback-loops.pdf` still tolls (it is not
 * a feed) while `/feed/` does not (WordPress's canonical feed carries a trailing slash, which
 * the old `feed[^/]*$` never matched either).
 */
const DISCOVERY_FILE_RE = /^(robots\.txt|llms\.txt|ads\.txt|app-ads\.txt|security\.txt|favicon\.ico)$/i;
/** `sitemap.xml`, `wp-sitemap.xml`, `post-sitemap.xml`, `sitemap_index.xml`, `sitemap-1.xml.gz`. */
const SITEMAP_FILE_RE = /(^|[-_.])sitemap([-_.][^/]*)?\.xml(\.gz)?$/i;
/** A feed only when the WHOLE segment is one — never a mere prefix. */
const FEED_FILE_RE = /^(feed|feeds|rss|atom|index)(\.(xml|rss|atom|json))?$/i;

/** The last non-empty path segment, so a trailing slash (`/feed/`) is read as `feed`. */
function lastSegment(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}

/** True when this path is a discovery surface that must never toll, whatever is opted in. */
function isDiscovery(pathname: string): boolean {
  if (DISCOVERY_ROOT_RE.test(pathname)) return true;
  const seg = lastSegment(pathname);
  return DISCOVERY_FILE_RE.test(seg) || SITEMAP_FILE_RE.test(seg) || FEED_FILE_RE.test(seg);
}

/**
 * Options for site-mode slugging. Absent — and an empty list — reproduce today's
 * behaviour exactly, which is what lets this field ship without re-keying a single
 * stored slug: it can only turn a path that had NO key into one that has one, never
 * change the key of a path that already had one.
 */
export interface SiteSlugOpts {
  /**
   * Extensions the publisher has opted INTO tolling — lowercase, no leading dot
   * (`["pdf", "json"]`). Everything else in `STATIC_EXT_RE` stays free.
   *
   * ORDER IS THE SAFETY PROPERTY. Control routes and discovery surfaces are refused
   * BEFORE this is consulted, so opting into `xml` cannot toll a sitemap and opting
   * into `json` cannot toll the JWKS. Tolling discovery would starve the catalog the
   * agents buy from, which is the one thing site mode has always refused to do.
   *
   * Normalised at the write path by `normalizeIncludeExtensions` (`@naulon/shared`);
   * this function is pure and assumes that has already run.
   */
  includeExtensions?: readonly string[];
}

/** A pathname's extension, lowercase and dotless, or `null` when it has none. */
function extensionOf(pathname: string): string | null {
  const m = pathname.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Site-mode slug: the full decoded pathname, or `null` for the surfaces that must stay
 * free — gate control routes, discovery (robots/sitemaps/feeds/favicon), static assets by
 * extension (`.txt`/`.xml`/`.json` included: machine-readable surfaces do not toll unless
 * the publisher opts them in through `opts.includeExtensions`), and the publisher's own
 * `excludePrefixes`.
 */
export function slugFromSitePath(path: string, excludePrefixes: string[], opts?: SiteSlugOpts): string | null {
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (isControlRoute(pathname)) return null;
  if (isDiscovery(pathname)) return null;
  if (STATIC_EXT_RE.test(pathname)) {
    const ext = extensionOf(pathname);
    // `gate_scope` is untyped jsonb with no CHECK, and both stores cast it rather than parse it.
    // A string value would make `.includes` a SUBSTRING matcher (`"json"` tolls every `.js`), and
    // an object or number throws a TypeError out of decide() — a 503 for every request on that
    // tenant, humans included. Fail toward free instead.
    const allow = Array.isArray(opts?.includeExtensions) ? opts.includeExtensions : [];
    if (ext === null || !allow.includes(ext)) return null;
  }
  const clean = excludePrefixes.filter(Boolean);
  if (clean.some((p) => pathname === `/${p}` || pathname.startsWith(`/${p}/`))) return null;
  return decodeSlug(pathname);
}

/** The pathname of an absolute URL, or `null` when it will not parse. The crawler holds
 *  full URLs where the gate holds request paths; this is the only difference between them. */
function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Prefix-mode slug from a full URL (`https://site/essays/on-stillness`) — the crawler-side
 * spelling of `slugFromPath`, so a staged catalog row is keyed exactly as the gate will key
 * the request that comes for it.
 */
export function deriveSlug(url: string, prefixes: string[]): string | null {
  const pathname = pathnameOf(url);
  return pathname === null ? null : slugFromPath(pathname, prefixes);
}

/** Site-mode slug from a full URL — the crawler-side spelling of `slugFromSitePath`.
 *  `opts` MUST be the same one the gate is configured with, or the crawler stages a row
 *  under a key the gate never asks for (or stages nothing for a path the gate tolls). */
export function deriveSiteSlug(url: string, excludePrefixes: string[], opts?: SiteSlugOpts): string | null {
  const pathname = pathnameOf(url);
  return pathname === null ? null : slugFromSitePath(pathname, excludePrefixes, opts);
}
