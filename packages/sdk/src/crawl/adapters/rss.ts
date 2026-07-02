/**
 * crawl/adapters/rss.ts — the always-available RSS/Atom feed adapter.
 *
 * The lowest-rank fallback: nearly every CMS exposes an RSS 2.0 or Atom feed. It yields
 * title, URL, author (`<author>`/`<dc:creator>` for RSS, `<author><name>` for Atom), and
 * publish date — enough for the catalog plane. Authors are feed STRINGS only (the map key);
 * never a wallet. All fetches go through the guarded fetcher, so even a derived feed URL can
 * only ever hit the proven origin host.
 */
import type { AdapterContext, DiscoveredArticle, DiscoveredAuthor, SourceAdapter } from "../types.ts";
import { parseXml, toArray, textOf } from "../xml.ts";
import { deriveSlug } from "../slug.ts";

/** Conventional feed paths, richest first. Probed only when no explicit `feedUrl` is set.
 *  `/feed/` (trailing slash) is WordPress's canonical feed — `/feed` 301-redirects to it, and the
 *  guarded fetcher deliberately does NOT chase redirects (off-origin redirect chasing is blocked),
 *  so without the slash variant every WordPress site would be missed by the RSS fallback. */
const CONVENTIONAL_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feeds/posts/default"];

async function fetchFeedXml(ctx: AdapterContext): Promise<string | null> {
  const candidates = ctx.config.feedUrl
    ? [ctx.config.feedUrl]
    : CONVENTIONAL_PATHS.map((p) => new URL(p, ctx.origin).toString());
  for (const url of candidates) {
    try {
      const res = await ctx.fetch(url);
      if (!res.ok) continue;
      const body = await res.text();
      if (/<(rss|feed)[\s>]/i.test(body)) return body; // looks like RSS or Atom
    } catch {
      // off-origin override, network error — try the next candidate.
    }
  }
  return null;
}

/** Pull the canonical link out of an Atom entry (`rel="alternate"` or the first link). */
function atomLink(entry: Record<string, unknown>): string {
  for (const l of toArray(entry["link"] as unknown)) {
    if (l && typeof l === "object") {
      const o = l as Record<string, unknown>;
      const rel = o["@_rel"];
      if (rel === undefined || rel === "alternate") return String(o["@_href"] ?? "");
    } else if (typeof l === "string") {
      return l;
    }
  }
  return "";
}

function authorsFromRssItem(item: Record<string, unknown>): DiscoveredAuthor[] {
  const names = new Set<string>();
  for (const raw of [...toArray(item["dc:creator"]), ...toArray(item["author"])]) {
    const t = textOf(raw).trim();
    if (!t) continue;
    const m = t.match(/\(([^)]+)\)\s*$/); // "a@b.com (Jane Roe)" → "Jane Roe"
    names.add(m ? m[1]!.trim() : t);
  }
  return [...names].map((name) => ({ name }));
}

function authorsFromAtomEntry(entry: Record<string, unknown>): DiscoveredAuthor[] {
  const out: DiscoveredAuthor[] = [];
  for (const a of toArray(entry["author"])) {
    if (a && typeof a === "object") {
      const name = textOf((a as Record<string, unknown>)["name"]).trim();
      if (name) out.push({ name });
    }
  }
  return out;
}

/** Normalize a feed date to ISO-8601, or undefined when unparseable (never throw). */
function normDate(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function discover(ctx: AdapterContext, xml: string): DiscoveredArticle[] {
  const doc = parseXml(xml);
  const out: DiscoveredArticle[] = [];

  // RSS 2.0: rss > channel > item
  const channel = (doc["rss"] as Record<string, unknown> | undefined)?.["channel"];
  for (const item of toArray((channel as Record<string, unknown> | undefined)?.["item"])) {
    const it = item as Record<string, unknown>;
    const url = textOf(it["link"]).trim();
    const slug = url ? deriveSlug(url, ctx.articlePrefixes) : null;
    if (!url || !slug) continue;
    out.push({
      slug,
      url,
      title: textOf(it["title"]).trim(),
      authors: authorsFromRssItem(it),
      publishedAt: normDate(textOf(it["pubDate"]) || textOf(it["dc:date"])),
    });
  }

  // Atom: feed > entry
  for (const entry of toArray((doc["feed"] as Record<string, unknown> | undefined)?.["entry"])) {
    const e = entry as Record<string, unknown>;
    const url = atomLink(e).trim();
    const slug = url ? deriveSlug(url, ctx.articlePrefixes) : null;
    if (!url || !slug) continue;
    out.push({
      slug,
      url,
      title: textOf(e["title"]).trim(),
      authors: authorsFromAtomEntry(e),
      publishedAt: normDate(textOf(e["published"]) || textOf(e["updated"])),
    });
  }
  return out;
}

export const rssAdapter: SourceAdapter = {
  id: "rss",
  rank: 10, // fallback — any platform-native adapter outranks it
  async detect(ctx) {
    return (await fetchFeedXml(ctx)) !== null;
  },
  async discover(ctx) {
    const xml = await fetchFeedXml(ctx);
    return xml ? discover(ctx, xml) : [];
  },
};
