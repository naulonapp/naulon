/**
 * crawl/media.ts — which NON-HTML files a crawl is allowed to discover.
 *
 * The gate tolls a file only when the publisher opted its extension in
 * (`gateScope.includeExtensions` → `slugFromSitePath`). Discovery has to agree, and until now it
 * could not: only the sitemap adapter ever emitted a non-HTML URL, so on a WordPress or RSS
 * catalogue a ticked `pdf` was discovered by nobody, `quote()` found no credits, and the file
 * served free forever — with every dashboard reporting the site as configured. No error, no signal.
 *
 * The list is the SAME list the gate reads, carried through `CrawlConfig`, for the same reason the
 * sweep already carries it into `deriveSiteSlug`: two planes that key the same URL differently
 * produce an article that never tolls, and there is no compile signal for it.
 *
 * It is also the BOUND. An empty list means "discover articles only" — the historical behaviour —
 * so a prefix-mode tenant, or a site-mode tenant that ticked nothing, never pays for a media crawl
 * it did not ask for and never floods its catalogue with every image on the site.
 */
import type { CrawlConfig } from "./types.ts";

/**
 * The opted-in extensions, normalised the way the write path stores them (lowercase, dotless).
 * Empty ⇒ this crawl discovers no files at all.
 *
 * It applies no policy of its own, deliberately. An earlier cut filtered a hard-coded "never
 * discover" set here — stylesheets, images, fonts — and that was a SECOND owner for a question
 * `normalizeIncludeExtensions` and `slugFromSitePath` already answer between them. Two owners is
 * how the crawl ends up refusing to stage a file the gate is charging for, which is precisely the
 * silent mismatch this module exists to close. Whatever the publisher opted in, the gate tolls;
 * whatever the gate tolls, the crawl discovers.
 */
export function mediaExtensions(config: Pick<CrawlConfig, "includeExtensions">): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of config.includeExtensions ?? []) {
    const ext = raw.trim().replace(/^\./, "").toLowerCase();
    if (ext) out.add(ext);
  }
  return out;
}

/** The lowercase, dotless extension of a URL's PATH, or "" when it has none. Query and fragment are
 *  excluded (`/report.pdf?v=2` is a pdf); a dot in a directory is not an extension
 *  (`/v1.2/notes` has none). Never throws — an unparseable url yields "". */
export function extensionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url, "https://x.invalid").pathname;
  } catch {
    return "";
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** Is this URL a file the publisher opted in to tolling? False for every HTML page, which is what
 *  keeps a media pass additive: it can only ever ADD rows the article pass would not have found. */
export function isOptedInFile(url: string, extensions: ReadonlySet<string>): boolean {
  return extensions.size > 0 && extensions.has(extensionOf(url));
}
