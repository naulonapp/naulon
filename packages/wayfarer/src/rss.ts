/**
 * RSS parsing — turn a publisher's `/rss.xml` into discovery candidates.
 *
 * Pure and dependency-free: a small RSS 2.0 reader, no XML library. The agent
 * reads only the free teaser fields here (it hasn't paid yet), so the parser
 * deliberately distinguishes the teaser (`<description>`/`<summary>`) from the
 * full body (`<content:encoded>`) — see `extractTeaser`.
 */
import type { Candidate } from "./types.ts";

/** One `<item>` lifted from the feed, before we decide what's free to read. */
export interface RssItem {
  title: string;
  link: string;
  /** RSS `<description>` — conventionally a teaser/lede, not the full body. */
  description: string;
  /** `<content:encoded>` — may be the FULL article body. Never a teaser. */
  contentEncoded?: string;
  guid?: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/** Decode the handful of XML entities a feed actually emits (+ numeric refs). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code[0] === "#") {
      const cp =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Strip a `<![CDATA[ ... ]]>` wrapper if present, then trim. */
function unwrap(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1]! : raw).trim();
}

/** Inner text of the first `<tag …>…</tag>` in `block`, decoded. "" if absent. */
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  const inner = unwrap(m[1]!);
  // CDATA content is literal; only decode entities outside a CDATA section.
  return /^\s*<!\[CDATA\[/.test(m[1]!) ? inner : decodeEntities(inner);
}

/** `href` of a self-closing `<link … href="…"/>` (Atom-style), decoded. "" if absent. */
function linkHref(block: string): string {
  const m = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  return m ? decodeEntities(m[1]!) : "";
}

/** Parse an RSS 2.0 (or Atom-ish) document into its items. Lenient by design. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)) {
    const block = m[0];
    const link = tag(block, "link") || linkHref(block);
    const item: RssItem = {
      title: tag(block, "title"),
      link,
      description: tag(block, "description") || tag(block, "summary"),
      guid: tag(block, "guid") || undefined,
    };
    const body = tag(block, "content:encoded");
    if (body) item.contentEncoded = body;
    items.push(item);
  }
  return items;
}

/** Slug = the last non-empty path segment of the item's link (or guid). */
export function slugFromLink(link: string): string {
  if (!link) return "";
  let path = link;
  try {
    path = new URL(link).pathname;
  } catch {
    // Relative or malformed — fall back to the raw string, sans query/hash.
    path = link.split(/[?#]/)[0]!;
  }
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The teaser boundary — what the agent may read for FREE, pre-payment.
 *
 * This is a product decision, not a parsing detail: a feed that ships the full
 * body in `<content:encoded>` would let the agent bypass the toll at discovery.
 * So we read the teaser field only and never the body, regardless of what the
 * feed includes. Keeping it a named function makes that line explicit and easy
 * to retune per publisher.
 */
export function extractTeaser(item: RssItem): string {
  return item.description.trim();
}

/** Map a parsed item to a free-teaser Candidate (slug + title + teaser). */
export function rssItemToCandidate(item: RssItem): Candidate {
  return {
    slug: slugFromLink(item.link || item.guid || ""),
    title: item.title,
    summary: extractTeaser(item),
  };
}

/** Full feed → candidates, dropping anything with no usable slug. */
export function rssToCandidates(xml: string): Candidate[] {
  return parseRss(xml)
    .map(rssItemToCandidate)
    .filter((c) => c.slug.length > 0);
}
