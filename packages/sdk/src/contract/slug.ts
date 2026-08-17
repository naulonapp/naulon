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
  return pathname.startsWith("/.well-known/") || pathname.startsWith("/licenses/");
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
const DISCOVERY_RE = /^\/(robots\.txt|sitemap[^/]*|rss[^/]*|atom[^/]*|feed[^/]*|favicon\.ico)$/i;

/**
 * Site-mode slug: the full decoded pathname, or `null` for the surfaces that must stay
 * free — gate control routes, discovery (robots/sitemaps/feeds/favicon), static assets by
 * extension (deliberately including `.txt`/`.xml`/`.json`: machine-readable surfaces never
 * toll), and the publisher's own `excludePrefixes`.
 */
export function slugFromSitePath(path: string, excludePrefixes: string[]): string | null {
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (isControlRoute(pathname)) return null;
  if (DISCOVERY_RE.test(pathname) || STATIC_EXT_RE.test(pathname)) return null;
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

/** Site-mode slug from a full URL — the crawler-side spelling of `slugFromSitePath`. */
export function deriveSiteSlug(url: string, excludePrefixes: string[]): string | null {
  const pathname = pathnameOf(url);
  return pathname === null ? null : slugFromSitePath(pathname, excludePrefixes);
}
