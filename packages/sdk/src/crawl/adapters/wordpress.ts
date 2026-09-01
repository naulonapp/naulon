/**
 * crawl/adapters/wordpress.ts — the WordPress REST adapter, highest-value.
 *
 * `GET {origin}/wp-json/wp/v2/posts?_embed` returns real post objects with REAL author objects
 * (`_embedded.author[].name`) — far richer than a feed's free-text `<author>`. Self-hosted
 * WordPress serves this from the publisher's own origin, so the guarded origin fetcher covers
 * it (no off-origin call, no API key). Paginated and page-capped to bound a large catalog.
 *
 * `_embed=1` is the rich mode but also the heavy one: on a big media site it inflates each post
 * with its full author/media/term objects, so a page can dwarf a bare listing (TechCrunch's
 * `_embed` page times out where the bare page is ~1.4 MiB / 2 s). So each page tries `_embed`
 * first, and on a fetch failure (timeout, or a body past the fetcher's 8 MiB cap that won't
 * parse) falls back to the BARE listing for that page — you still capture the full catalog
 * (url/title/date). A partial-but-complete catalog beats failing on the biggest sites.
 *
 * POSTS ARE NOT THE WHOLE CATALOGUE. `/wp/v2/posts` lists posts, never the media library — so a
 * publisher who opted `pdf` in to the toll (`gateScope.includeExtensions`) got a WordPress crawl
 * that discovered no PDF at all, and the file served free forever with no signal anywhere. When
 * and only when the crawl config names extensions, a second pass reads `/wp/v2/media` and emits
 * the attachments whose extension was opted in. Empty list ⇒ not a single extra request.
 *
 * A bare listing drops `_embedded` but STILL carries each post's numeric `author` id, so the
 * names are recoverable: fetch the origin's public user directory (`/wp-json/wp/v2/users`) ONCE,
 * lazily, memoized, and join id → name. Without that join an `_embed`-timeout site yields a
 * catalog where every article is unmapped — the whole crawl lands on the human's desk. Only when
 * `/users` is disabled (privacy plugins → 401/403 or a non-array body) do the names fall through,
 * and then resolution falls to `defaultWallet`; money is never inferred either way.
 */
import type { AdapterContext, ArticleCandidate, DiscoveredAuthor, SourceAdapter } from "../types.ts";
import { isOptedInFile, mediaExtensions } from "../media.ts";

const PER_PAGE = 50;
const MAX_PAGES = 40; // ≤ 2000 posts/crawl
const MAX_MEDIA_PAGES = 20; // ≤ 1000 attachments/crawl, and only when extensions were opted in

/** WordPress's coarse `media_type` filter — a documented enum (`image|video|text|audio|application
 *  |file`), unlike the exact `mime_type`, which varies by how a given upload was registered (an
 *  `.xml` is `text/xml` on one install and `application/xml` on another). Filtering coarsely and
 *  matching the EXTENSION locally is what makes this robust across installs: the query only has to
 *  keep the image library out of the paging budget. An extension we cannot bucket asks for both. */
const MEDIA_TYPE_BUCKETS: Readonly<Record<string, string>> = {
  pdf: "application",
  json: "application",
  zip: "application",
  csv: "text",
  txt: "text",
  xml: "text",
  md: "text",
};

interface WpPost {
  link?: string;
  date_gmt?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  /** The numeric author id a BARE listing carries (no `_embedded`). Dropping it is what used to
   *  make an `_embed`-timeout crawl produce an entirely unmapped catalog. */
  author?: number;
  _embedded?: { author?: Array<{ name?: string; id?: number; slug?: string }> };
}

/** One attachment from `/wp-json/wp/v2/media`. `source_url` is the FILE — `link` is the WordPress
 *  attachment PAGE (HTML), which is not the thing an agent fetches and not the thing the gate
 *  tolls, so a row without `source_url` is skipped rather than falling back to it. */
interface WpMedia {
  source_url?: string;
  date_gmt?: string;
  title?: { rendered?: string };
  /** The uploader. WordPress's own attribution for the file, and only ever a `authorWalletMap`
   *  KEY here — money is never inferred, so an unmapped uploader falls to `defaultWallet` exactly
   *  as an unmapped post author does. */
  author?: number;
}

/** One row of `/wp-json/wp/v2/users` — the id → name directory joined onto bare posts. */
interface WpUser {
  id?: number;
  name?: string;
  slug?: string;
}

/** WP renders excerpts as HTML with a "Continue reading" tail; strip tags, collapse, cap. */
function excerptOf(post: WpPost): string | undefined {
  const s = (post.excerpt?.rendered ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, 500) : undefined;
}

/** Authors embedded on a rich (`_embed`) post. Bare posts have none — the id join recovers them. */
function authorsOf(post: WpPost): DiscoveredAuthor[] {
  const out: DiscoveredAuthor[] = [];
  for (const a of post._embedded?.author ?? []) {
    const name = (a?.name ?? "").trim();
    if (name) out.push({ name, externalId: a?.id !== undefined ? String(a.id) : a?.slug });
  }
  return out;
}

/** Fetch the origin's public user directory → `id → name`. One call per crawl (the caller
 *  memoizes). A disabled or blocked `/users` (privacy plugins → 401/403, or a non-array body)
 *  yields an EMPTY map, never a throw — the join then recovers nothing and author resolution
 *  falls to `defaultWallet`, which is the same place a nameless post already landed.
 *  Same-origin, so the guarded fetcher covers it and no capability is required. */
async function fetchUsersMap(ctx: AdapterContext): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await ctx.fetch(new URL("/wp-json/wp/v2/users?per_page=100", ctx.origin).toString());
    if (!res.ok) return map;
    const body = await res.json();
    if (!Array.isArray(body)) return map;
    for (const u of body as WpUser[]) {
      const name = (u?.name ?? "").trim();
      if (u?.id !== undefined && name) map.set(u.id, name);
    }
  } catch {
    // fetch/parse failure → empty map (silent fall-through, not a crawl failure)
  }
  return map;
}

/** One page of posts, or a sentinel: `"stop"` = no more pages (WP 400 / non-array / empty is
 *  handled by the caller), `"error"` = the fetch itself failed (timeout / unparseable body). */
type PageResult = WpPost[] | "stop" | "error";

async function fetchPostsPage(ctx: AdapterContext, page: number, embed: boolean): Promise<PageResult> {
  const url = new URL(
    `/wp-json/wp/v2/posts?${embed ? "_embed=1&" : ""}per_page=${PER_PAGE}&page=${page}&status=publish`,
    ctx.origin,
  ).toString();
  try {
    const res = await ctx.fetch(url);
    if (!res.ok) return "stop"; // WP returns 400 past the last page → stop
    const body = await res.json();
    if (!Array.isArray(body)) return "stop";
    return body as WpPost[];
  } catch {
    return "error";
  }
}

/** One page of the media library, filtered coarsely by `media_type`. Same sentinel contract as
 *  `fetchPostsPage`: `"stop"` = no more pages (WP 400s past the last one), `"error"` = the fetch
 *  itself failed. */
async function fetchMediaPage(ctx: AdapterContext, bucket: string, page: number): Promise<WpMedia[] | "stop" | "error"> {
  const url = new URL(
    `/wp-json/wp/v2/media?per_page=${PER_PAGE}&page=${page}&media_type=${encodeURIComponent(bucket)}`,
    ctx.origin,
  ).toString();
  try {
    const res = await ctx.fetch(url);
    if (!res.ok) return "stop";
    const body = await res.json();
    if (!Array.isArray(body)) return "stop";
    return body as WpMedia[];
  } catch {
    return "error";
  }
}

/**
 * The FILES pass — the half `/wp/v2/posts` structurally cannot see.
 *
 * Runs only when the publisher opted extensions in, so the default WordPress crawl is byte-for-byte
 * what it was. Never throws and never breaks the article pass: a media library that 404s (the
 * endpoint is disabled) or errors mid-page keeps whatever it found, because a partial catalogue
 * beats losing the posts over an attachment.
 */
async function discoverMedia(
  ctx: AdapterContext,
  extensions: ReadonlySet<string>,
  ensureUsers: () => Promise<Map<number, string>>,
): Promise<ArticleCandidate[]> {
  const buckets = new Set<string>();
  for (const ext of extensions) {
    const bucket = MEDIA_TYPE_BUCKETS[ext];
    if (bucket) buckets.add(bucket);
    else { buckets.add("application"); buckets.add("text"); } // unknown extension → ask both
  }

  const out: ArticleCandidate[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (let page = 1; page <= MAX_MEDIA_PAGES; page++) {
      const items = await fetchMediaPage(ctx, bucket, page);
      if (items === "stop" || items === "error" || items.length === 0) break;
      for (const item of items) {
        const url = (item.source_url ?? "").trim();
        if (!url || seen.has(url)) continue;
        if (!isOptedInFile(url, extensions)) continue; // an image in the `application` bucket, a .doc, …
        seen.add(url);
        const date = (item.date_gmt ?? "").trim();
        const stated = (item.title?.rendered ?? "").trim();
        const authors: DiscoveredAuthor[] = [];
        if (item.author !== undefined) {
          const name = (await ensureUsers()).get(item.author);
          if (name) authors.push({ name, externalId: String(item.author) });
        }
        out.push({
          url,
          // WordPress titles an attachment after its filename by default, which is already the
          // best available name for a file. A blank one falls back to the filename itself rather
          // than staging a row a human cannot recognise in the review queue.
          title: stated || decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)),
          authors,
          publishedAt: date && Number.isFinite(Date.parse(`${date}Z`)) ? new Date(`${date}Z`).toISOString() : undefined,
        });
      }
      if (items.length < PER_PAGE) break; // last page
    }
  }
  return out;
}

export const wordpressAdapter: SourceAdapter = {
  id: "wordpress",
  rank: 100, // real author objects → outranks feeds
  curated: true, // the REST posts endpoint lists real articles, not every URL
  async detect(ctx) {
    try {
      const res = await ctx.fetch(new URL("/wp-json/wp/v2/posts?per_page=1", ctx.origin).toString());
      if (!res.ok) return false;
      return Array.isArray(await res.json());
    } catch {
      return false;
    }
  },
  async discover(ctx) {
    const out: ArticleCandidate[] = [];
    // Try `_embed` (author names) until it fails once; a site that times out an `_embed` page
    // times out every one, so latch to bare after the first failure rather than eating the
    // fetcher timeout on all MAX_PAGES pages (that turned a big embed-hostile site into minutes).
    let useEmbed = true;
    // The users directory — fetched LAZILY (only when a bare post needs it) and memoized to one
    // call per crawl. A healthy `_embed` site never touches `/users`; an empty result caches too,
    // so a disabled endpoint is not re-probed once per page.
    let usersMap: Map<number, string> | null = null;
    const ensureUsers = async (): Promise<Map<number, string>> => {
      if (usersMap === null) usersMap = await fetchUsersMap(ctx);
      return usersMap;
    };
    for (let page = 1; page <= MAX_PAGES; page++) {
      let posts = await fetchPostsPage(ctx, page, useEmbed);
      if (posts === "error" && useEmbed) {
        // The `_embed` page was too heavy (timeout / oversized body). Drop to BARE for this page
        // and every page after — the catalog survives; only author names are lost (→ resolves to
        // `defaultWallet`, never inferred).
        useEmbed = false;
        posts = await fetchPostsPage(ctx, page, false);
      }
      if (posts === "error") {
        // Even the bare listing failed. `detect` already proved page 1 serves posts, so a
        // page-1 failure is a real fault — surface it loudly, don't draft an empty credits.json.
        // A later-page failure keeps what earlier pages yielded (a partial catalog beats none).
        if (page === 1) {
          throw new Error(
            `WordPress REST discovery failed on the first page (${new URL("/wp-json/wp/v2/posts", ctx.origin).toString()}) — even without _embed. The origin may be timing out or blocking the crawler.`,
          );
        }
        break;
      }
      if (posts === "stop" || posts.length === 0) break;
      for (const post of posts) {
        const link = (post.link ?? "").trim();
        if (!link) continue;
        const date = (post.date_gmt ?? "").trim();
        let authors = authorsOf(post);
        if (authors.length === 0 && post.author !== undefined) {
          // Bare mode: resolve the numeric author id through the once-per-crawl users directory.
          // A miss (id absent, or `/users` disabled) leaves `[]` → resolution falls to
          // `defaultWallet`, and an unmapped article is reported rather than tolled to a guess.
          const name = (await ensureUsers()).get(post.author);
          if (name) authors = [{ name, externalId: String(post.author) }];
        }
        out.push({
          url: link,
          title: (post.title?.rendered ?? "").trim(),
          summary: excerptOf(post),
          authors,
          // WP date_gmt has no zone suffix; it IS UTC → append Z before parsing.
          publishedAt: date && Number.isFinite(Date.parse(`${date}Z`)) ? new Date(`${date}Z`).toISOString() : undefined,
        });
      }
      if (posts.length < PER_PAGE) break; // last page
    }
    // The files the publisher opted in to tolling. Additive by construction — every candidate here
    // is a non-HTML URL, so it can only ever be one `/wp/v2/posts` never returned.
    const extensions = mediaExtensions(ctx.config);
    if (extensions.size > 0) out.push(...(await discoverMedia(ctx, extensions, ensureUsers)));
    return out;
  },
};
