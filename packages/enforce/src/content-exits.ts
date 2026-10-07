/**
 * Content exits: routes that hand out an article's full text without going through its page.
 *
 * A toll on the article page means nothing if the same words leave by another door. WordPress has
 * two such doors on every install: its REST API (`/wp-json/wp/v2/…`, or `?rest_route=/wp/v2/…` on a
 * site without pretty permalinks) returns each post's rendered body, and its feeds include the full
 * text by default. For a requester the toll would charge, each exit returns the same response with
 * the article text removed and the teaser kept, so an agent can still find the work and pays for it
 * at the article's URL. Anyone the toll serves free gets the response untouched.
 *
 * Each exit is one entry in `CONTENT_EXITS`: how to recognise its requests, and how to strip its
 * response. Supporting another platform's door is one more entry.
 */

export interface ContentExit {
  /** Stable id, reported on the response so a stripped body is never mistaken for the origin's. */
  id: string;
  /** Does this request reach this exit? */
  matches(url: URL): boolean;
  /**
   * The body with full article text removed, or null when the body is not this exit's shape (an
   * error page, an unexpected format). A null answer serves the origin's response unchanged.
   */
  strip(body: string, contentType: string, url: URL): string | null;
  /**
   * Refuse a successful response this exit cannot strip, instead of serving it. Set where the route
   * is unambiguously the platform's (WordPress's `/wp/v2/` API), so an unreadable body can only be a
   * format variant that would otherwise leak. Unset where the same path may be an ordinary page on
   * another kind of site (a `/feed/` page that is not a WordPress feed).
   */
  failClosed?: boolean;
}

/**
 * Replace every rendered body in a REST payload (lists, single posts, `_embed`ded posts) with its
 * excerpt, marked protected the way WordPress marks a password-protected post.
 *
 * Decided by ROUTE, never by the shape of the objects: a requester chooses which fields come back
 * (`?_fields=id,content`), so any test on another field is one it can remove. Every `/wp/v2/` route
 * that carries `content` serves an article's body except comments, which `routeOf` exempts.
 */
function stripBodies(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripBodies(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    // Embedded comments under a post keep their text: a comment is not the article.
    if (key === "replies") continue;
    if (key === "content" && typeof value === "object" && value !== null && typeof (value as { rendered?: unknown }).rendered === "string") {
      const excerpt = obj["excerpt"];
      const teaser =
        typeof excerpt === "object" && excerpt !== null && typeof (excerpt as { rendered?: unknown }).rendered === "string"
          ? (excerpt as { rendered: string }).rendered
          : "";
      obj[key] = { ...(value as Record<string, unknown>), rendered: teaser, protected: true };
      continue;
    }
    stripBodies(value);
  }
}

/**
 * The `/wp/v2/...` route of a REST request, or null. WordPress answers the API under three
 * spellings: `/wp-json/…`, `/index.php/wp-json/…` (PATH_INFO, on servers without rewrites) and
 * `?rest_route=…`. Compared lower-case with repeated slashes collapsed, as a server would route it.
 */
function routeOf(url: URL): string | null {
  const path = url.pathname.replace(/\/+/g, "/").toLowerCase();
  for (const prefix of ["/wp-json", "/index.php/wp-json"]) {
    if (path.startsWith(`${prefix}/wp/v2/`)) return path.slice(prefix.length);
  }
  const rest = (url.searchParams.get("rest_route") ?? "").replace(/\/+/g, "/").toLowerCase();
  return rest.startsWith("/wp/v2/") ? rest : null;
}

/** WordPress's JSONP answer (`?_jsonp=cb`, on by default): `/**\/cb(<json>)`. */
const JSONP = /^\s*(\/\*\*\/)?\s*([A-Za-z_$][\w.$]*)\(([\s\S]*)\)\s*;?\s*$/;

export const WORDPRESS_REST: ContentExit = {
  id: "wordpress-rest",
  matches(url) {
    return routeOf(url) !== null;
  },
  failClosed: true,
  strip(body, contentType, url) {
    // Comments carry `content` too, and it is the commenter's text, not the article.
    if (/^\/wp\/v2\/comments(\/|$)/.test(routeOf(url) ?? "")) return body;
    const jsonp = /javascript/i.test(contentType) ? JSONP.exec(body) : null;
    if (!jsonp && !/json/i.test(contentType)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonp ? jsonp[3]! : body);
    } catch {
      return null;
    }
    stripBodies(parsed);
    const json = JSON.stringify(parsed);
    return jsonp ? `${jsonp[1] ?? ""}${jsonp[2]}(${json})` : json;
  },
};

/** WordPress's legacy feed files, still routed by core. */
const LEGACY_FEED_FILE = /^wp-(rss|rss2|atom|rdf)\.php$/i;

export const WORDPRESS_FEED: ContentExit = {
  id: "wordpress-feed",
  // Every WordPress feed is served under a literal `feed` segment (`/feed/`, `/feed/atom/`,
  // `/category/x/feed/`), by `?feed=`, or by a legacy `wp-rss2.php`-style file.
  matches(url) {
    if (url.searchParams.has("feed")) return true;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.some((s) => s.toLowerCase() === "feed") || LEGACY_FEED_FILE.test(segments.at(-1) ?? "");
  },
  strip(body, contentType) {
    if (!/xml|rss|atom|rdf/i.test(contentType) && !/^\s*<\?xml|<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(body.slice(0, 512))) return null;
    // RSS 2.0 and RDF carry the body in content:encoded; Atom in <content>. The summary
    // (<description>, <summary>) stays: it is the teaser the feed exists to publish.
    return body
      .replace(/<content:encoded\b[^>]*>[\s\S]*?<\/content:encoded>/gi, "")
      .replace(/<content:encoded\b[^>]*\/>/gi, "")
      .replace(/<content\b(?![:\w])[^>]*>[\s\S]*?<\/content>/gi, "")
      .replace(/<content\b(?![:\w])[^>]*\/>/gi, "");
  },
};

/** Every exit, in the order they are tried. */
export const CONTENT_EXITS: readonly ContentExit[] = [WORDPRESS_REST, WORDPRESS_FEED];

/** The exit a request reaches, if any. */
export function contentExitFor(url: URL, exits: readonly ContentExit[] = CONTENT_EXITS): ContentExit | null {
  return exits.find((e) => e.matches(url)) ?? null;
}
