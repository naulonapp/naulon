/**
 * crawl/adapters/rss.ts — the always-available RSS/Atom feed adapter.
 *
 * The lowest-rank fallback: nearly every CMS exposes an RSS 2.0 or Atom feed. It yields
 * title, URL, teaser, author (`<author>`/`<dc:creator>` for RSS, `<author><name>` for Atom), and
 * publish date — enough for the catalog plane. Authors are feed STRINGS only (the map key);
 * never a wallet. All fetches go through the guarded fetcher, so even a derived feed URL can
 * only ever hit the proven origin host.
 *
 * A feed also carries ATTACHMENTS — `<enclosure url>` in RSS, `<link rel="enclosure">` in Atom,
 * `<media:content url>` in the Media RSS extension every podcast and most CMS feeds emit. Those
 * were dropped on the floor, so a publisher who opted `pdf` in to the toll got an RSS crawl that
 * discovered the POST and never the PDF hanging off it: the gate tolled a URL nothing had staged
 * credits for, and the file served free forever. They are emitted now, but ONLY for the extensions
 * the publisher opted in (`gateScope.includeExtensions`) — otherwise a podcast feed would stage a
 * thousand MP3s nobody asked to sell. An attachment inherits its item's authors and date, because
 * that is who published it; the title falls back to the filename.
 */
import type { AdapterContext, ArticleCandidate, DiscoveredAuthor, SourceAdapter } from "../types.ts";
import { parseXml, toArray, textOf } from "../xml.ts";
import { isOptedInFile, mediaExtensions } from "../media.ts";

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

/** Feed description → plain text: strip tags, collapse whitespace, cap length. '' → undefined.
 *  The publisher's own teaser, so a catalog page never has to invent one. */
function summaryOf(raw: unknown): string | undefined {
  const s = textOf(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, 500) : undefined;
}

/** Normalize a feed date to ISO-8601, or undefined when unparseable (never throw). */
function normDate(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Every attachment URL an item declares, across the three spellings that exist in the wild.
 *  Order is stable and duplicates are the caller's problem (it dedupes across the whole feed). */
function enclosureUrls(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    // RSS `<enclosure url>` and Media RSS `<media:content url>` both use `url`; Atom's
    // `<link rel="enclosure" href>` uses `href` and must declare the rel — a bare `<link>` is the
    // entry's own permalink and is already handled as the article.
    const rel = o["@_rel"];
    const href = o["@_url"] ?? (rel === "enclosure" ? o["@_href"] : undefined);
    const url = typeof href === "string" ? href.trim() : "";
    if (url) out.push(url);
  };
  for (const key of ["enclosure", "media:content", "link"]) for (const n of toArray(node[key])) push(n);
  return out;
}

function discover(xml: string, extensions: ReadonlySet<string>): ArticleCandidate[] {
  const doc = parseXml(xml);
  const out: ArticleCandidate[] = [];
  const seenFiles = new Set<string>();
  /** Stage an item's attachments beside the item itself. A no-op when nothing was opted in, which
   *  is what keeps a feed crawl identical to what it has always been for every other publisher. */
  const withFiles = (node: Record<string, unknown>, article: ArticleCandidate) => {
    out.push(article);
    if (extensions.size === 0) return;
    for (const url of enclosureUrls(node)) {
      if (seenFiles.has(url) || !isOptedInFile(url, extensions)) continue;
      seenFiles.add(url);
      out.push({
        url,
        title: decodeURIComponent(url.slice(url.lastIndexOf("/") + 1).split("?")[0] ?? "") || article.title,
        authors: article.authors,
        publishedAt: article.publishedAt,
      });
    }
  };

  // RSS 2.0: rss > channel > item
  const channel = (doc["rss"] as Record<string, unknown> | undefined)?.["channel"];
  for (const item of toArray((channel as Record<string, unknown> | undefined)?.["item"])) {
    const it = item as Record<string, unknown>;
    const url = textOf(it["link"]).trim();
    if (!url) continue;
    withFiles(it, {
      url,
      title: textOf(it["title"]).trim(),
      summary: summaryOf(it["description"]),
      authors: authorsFromRssItem(it),
      publishedAt: normDate(textOf(it["pubDate"]) || textOf(it["dc:date"])),
    });
  }

  // Atom: feed > entry
  for (const entry of toArray((doc["feed"] as Record<string, unknown> | undefined)?.["entry"])) {
    const e = entry as Record<string, unknown>;
    const url = atomLink(e).trim();
    if (!url) continue;
    withFiles(e, {
      url,
      title: textOf(e["title"]).trim(),
      summary: summaryOf(e["summary"] ?? e["content"]),
      authors: authorsFromAtomEntry(e),
      publishedAt: normDate(textOf(e["published"]) || textOf(e["updated"])),
    });
  }
  return out;
}

export const rssAdapter: SourceAdapter = {
  id: "rss",
  rank: 10, // fallback — any platform-native adapter outranks it
  curated: true, // a feed lists real posts, not every URL on the site
  async detect(ctx) {
    return (await fetchFeedXml(ctx)) !== null;
  },
  async discover(ctx) {
    const xml = await fetchFeedXml(ctx);
    return xml ? discover(xml, mediaExtensions(ctx.config)) : [];
  },
};
