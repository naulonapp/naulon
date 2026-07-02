/**
 * crawl/adapters/sitemap.ts — the sitemap.xml URL-discovery adapter.
 *
 * The other always-available fallback. A sitemap is a flat list of URLs (and an INDEX is a
 * list of sitemaps); it carries no author or title, so this adapter yields URL + slug +
 * lastmod only — author resolution then falls to `defaultWallet`. Include/exclude globs do
 * the article filtering, since a sitemap lists every URL, not just articles. Index recursion
 * is depth- and child-count-capped to bound a hostile or huge sitemap.
 */
import type { AdapterContext, DiscoveredArticle, SourceAdapter } from "../types.ts";
import { parseXml, toArray, textOf } from "../xml.ts";
import { deriveSlug } from "../slug.ts";
import { passesGlobs } from "../glob.ts";

const CONVENTIONAL_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"];
const MAX_INDEX_DEPTH = 2; // index → child sitemaps → (no deeper)
const MAX_CHILD_SITEMAPS = 50;

async function fetchSitemapXml(ctx: AdapterContext, url: string): Promise<string | null> {
  try {
    const res = await ctx.fetch(url);
    if (!res.ok) return null;
    const body = await res.text();
    return /<(urlset|sitemapindex)[\s>]/i.test(body) ? body : null;
  } catch {
    return null;
  }
}

/** Resolve the root sitemap: explicit `feedUrl` if it points at a sitemap, else conventional. */
async function rootSitemap(ctx: AdapterContext): Promise<string | null> {
  const candidates = ctx.config.feedUrl?.includes("sitemap")
    ? [ctx.config.feedUrl]
    : CONVENTIONAL_PATHS.map((p) => new URL(p, ctx.origin).toString());
  for (const url of candidates) {
    const xml = await fetchSitemapXml(ctx, url);
    if (xml) return xml;
  }
  return null;
}

interface RawUrl {
  loc: string;
  lastmod?: string;
}

/** Collect `<loc>`s from a sitemap or (recursively, capped) a sitemap index. */
async function collectUrls(ctx: AdapterContext, xml: string, depth: number): Promise<RawUrl[]> {
  const doc = parseXml(xml);

  const index = doc["sitemapindex"] as Record<string, unknown> | undefined;
  if (index) {
    if (depth >= MAX_INDEX_DEPTH) return [];
    const out: RawUrl[] = [];
    let fetched = 0;
    for (const sm of toArray(index["sitemap"])) {
      if (fetched >= MAX_CHILD_SITEMAPS) break;
      const loc = textOf((sm as Record<string, unknown>)["loc"]).trim();
      if (!loc) continue;
      fetched++;
      const childXml = await fetchSitemapXml(ctx, loc);
      if (childXml) out.push(...(await collectUrls(ctx, childXml, depth + 1)));
    }
    return out;
  }

  const urlset = doc["urlset"] as Record<string, unknown> | undefined;
  const out: RawUrl[] = [];
  for (const u of toArray(urlset?.["url"])) {
    const o = u as Record<string, unknown>;
    const loc = textOf(o["loc"]).trim();
    if (loc) out.push({ loc, lastmod: textOf(o["lastmod"]).trim() || undefined });
  }
  return out;
}

function toArticles(ctx: AdapterContext, urls: RawUrl[]): DiscoveredArticle[] {
  const out: DiscoveredArticle[] = [];
  const seen = new Set<string>();
  for (const { loc, lastmod } of urls) {
    let pathname: string;
    try {
      pathname = new URL(loc).pathname;
    } catch {
      continue;
    }
    if (!passesGlobs(pathname, ctx.config.includeGlobs, ctx.config.excludeGlobs)) continue;
    const slug = deriveSlug(loc, ctx.articlePrefixes);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      url: loc,
      title: "", // sitemaps carry no title — the merge falls back to the slug
      authors: [], // no author signal → resolution falls to defaultWallet
      publishedAt: lastmod && Number.isFinite(Date.parse(lastmod)) ? new Date(lastmod).toISOString() : undefined,
    });
  }
  return out;
}

export const sitemapAdapter: SourceAdapter = {
  id: "sitemap",
  rank: 5, // lowest — no author/title, pure URL discovery
  async detect(ctx) {
    return (await rootSitemap(ctx)) !== null;
  },
  async discover(ctx) {
    const xml = await rootSitemap(ctx);
    if (!xml) return [];
    return toArticles(ctx, await collectUrls(ctx, xml, 0));
  },
};
