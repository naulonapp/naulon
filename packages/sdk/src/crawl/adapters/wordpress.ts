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
 * (slug/title/date), only the author NAMES are lost, so resolution falls to `defaultWallet`
 * (money is never inferred). A partial-but-complete catalog beats failing on the biggest sites.
 */
import type { AdapterContext, DiscoveredArticle, DiscoveredAuthor, SourceAdapter } from "../types.ts";
import { deriveSlug } from "../slug.ts";

const PER_PAGE = 50;
const MAX_PAGES = 40; // ≤ 2000 posts/crawl

interface WpPost {
  link?: string;
  date_gmt?: string;
  title?: { rendered?: string };
  _embedded?: { author?: Array<{ name?: string; id?: number; slug?: string }> };
}

function authorsOf(post: WpPost): DiscoveredAuthor[] {
  const out: DiscoveredAuthor[] = [];
  for (const a of post._embedded?.author ?? []) {
    const name = (a?.name ?? "").trim();
    if (name) out.push({ name, externalId: a?.id !== undefined ? String(a.id) : a?.slug });
  }
  return out;
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

export const wordpressAdapter: SourceAdapter = {
  id: "wordpress",
  rank: 100, // real author objects → outranks feeds
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
    const out: DiscoveredArticle[] = [];
    // Try `_embed` (author names) until it fails once; a site that times out an `_embed` page
    // times out every one, so latch to bare after the first failure rather than eating the
    // fetcher timeout on all MAX_PAGES pages (that turned a big embed-hostile site into minutes).
    let useEmbed = true;
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
        const slug = link ? deriveSlug(link, ctx.articlePrefixes) : null;
        if (!link || !slug) continue;
        const date = (post.date_gmt ?? "").trim();
        out.push({
          slug,
          url: link,
          title: (post.title?.rendered ?? "").trim(),
          authors: authorsOf(post), // bare pages have no `_embedded` → [] → resolves to defaultWallet
          // WP date_gmt has no zone suffix; it IS UTC → append Z before parsing.
          publishedAt: date && Number.isFinite(Date.parse(`${date}Z`)) ? new Date(`${date}Z`).toISOString() : undefined,
        });
      }
      if (posts.length < PER_PAGE) break; // last page
    }
    return out;
  },
};
