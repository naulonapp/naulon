/**
 * Find a publisher's RSL licence — the read side of discovery.
 *
 * RSL 1.0 defines five association mechanisms. Four are reachable over HTTP and are implemented
 * here; the fifth (embedding in media metadata — EPUB, XMP, ID3) is a file-format concern, not a
 * fetch, and belongs wherever those files are opened.
 *
 *   1. `robots.txt` — a `License: <absolute-URI>` directive. One fetch, covers the whole origin.
 *   2. HTTP `Link:` header — `Link: <url>; rel="license"; type="application/rsl+xml"`.
 *   3. HTML `<link rel="license" type="application/rsl+xml" href="…">`.
 *   4. HTML inline `<script type="application/rsl+xml">…</script>` — association-scoped.
 *
 * ## Why page-level beats robots when we already have the page
 *
 * The spec ranks `<content>` scopes, not channels, so nothing makes one channel authoritative over
 * another. But a page's own declaration is by construction about that page, while robots is about
 * the origin — and the failure that matters is one-directional: taking a page-level PRICE for a
 * site-level FREE loses a publisher money, and never the reverse. So when the caller already holds
 * the response (a buying agent always does — its 402 probe IS that response), page-level is checked
 * first and costs nothing. With no response in hand, robots is checked first because it is one
 * request that answers for every URL on the origin.
 *
 * ## The fetch boundary
 *
 * Every request goes through a `Fetcher` built per-origin, so `crawl/net.ts`'s SSRF CIDR block and
 * anti-rebind lookup apply to a licence URL exactly as they do to a crawl. A `License:` directive
 * is publisher-controlled input that names an arbitrary absolute URI — pointing it at
 * `http://169.254.169.254/` is the obvious attack, and it is refused by the same guard that refuses
 * it for a sitemap. Off-origin licence URLs are ALLOWED (a publisher may host terms on a
 * collective's domain), just never unguarded.
 */
import { makeGuardedFetcher } from "../crawl/fetcher.ts";
import type { Fetcher } from "../crawl/types.ts";
import { parseRslOrNull } from "./parse.ts";
import type { RslDocument } from "./types.ts";

/** Which association mechanism produced the document — carried so an operator can see WHY. */
export type RslSource = "robots" | "link-header" | "html-link" | "html-inline";

export interface LocatedLicence {
  source: RslSource;
  /** Where it was fetched from. Absent for `html-inline`, which has no separate document. */
  documentUrl?: string;
  doc: RslDocument;
  /** Set for `html-inline`: an empty `content@url` in this document means exactly this path. */
  associationPath?: string;
}

/** A response the caller already has for the target URL — a buying agent's own probe. */
export interface ObservedResponse {
  /** Lower-cased response headers (`FetchResult.headers`). */
  headers?: Record<string, string>;
  /** The response body, when it is HTML. A 402 challenge body is usually not; passing it anyway is
   *  harmless — the two HTML patterns simply do not match. */
  body?: string;
}

export interface LocateOptions {
  /**
   * Build the guarded fetcher for one origin. Injected so tests drive this module with no network,
   * and so a host with its own egress policy supplies it. Default: `makeGuardedFetcher`.
   */
  fetcherFor?: (origin: string) => Fetcher;
  /** A response for the target the caller already holds. Checked before anything is fetched. */
  observed?: ObservedResponse;
  /**
   * Fetch the target page when the cheap channels find nothing. Default false: this module is
   * called on the money path, and a speculative GET of a page the agent has not decided to buy is
   * a request the publisher did not ask for. A caller that wants the last channel opts in.
   */
  fetchPage?: boolean;
  /** The agent's robots.txt token, for a `License:` inside a `User-agent` group. */
  userAgent?: string;
}

const defaultFetcherFor = (origin: string): Fetcher => makeGuardedFetcher({ origin, timeoutMs: 8_000 });

/**
 * Extract the `License:` directive from robots.txt.
 *
 * Group handling, most specific first: a directive inside a group naming this agent, then one
 * inside the `*` group, then one stated before any `User-agent` line (global). RFC 9309's own
 * merging rules are richer than this; a licence pointer is not a crawl permission, and the extra
 * precision would be untested surface. What matters is that a publisher who wrote it once, anywhere
 * sensible, is found.
 */
export function licenseUrlFromRobots(robots: string, userAgent?: string): string | null {
  const ua = userAgent?.toLowerCase();
  let group: string[] = []; // the User-agent tokens of the group being read
  let global: string | null = null;
  let starGroup: string | null = null;
  let uaGroup: string | null = null;
  let inGroup = false;

  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      // A run of consecutive User-agent lines forms ONE group.
      if (!inGroup) group = [];
      group.push(value.toLowerCase());
      inGroup = true;
      continue;
    }
    inGroup = false;
    if (key !== "license" || value === "") continue;
    if (group.length === 0) global ??= value;
    else {
      if (group.includes("*")) starGroup ??= value;
      if (ua && group.some((g) => g !== "*" && ua.includes(g))) uaGroup ??= value;
    }
  }
  return uaGroup ?? starGroup ?? global;
}

/** `Link: <url>; rel="license"; type="application/rsl+xml"` — the header channel. */
export function licenseUrlFromLinkHeader(header: string | undefined): string | null {
  if (!header) return null;
  // Split on commas that separate link-values, not on commas inside <…> or a quoted string.
  for (const part of header.split(/,(?=\s*<)/)) {
    const target = part.match(/<([^>]*)>/)?.[1];
    if (!target) continue;
    const rel = part.match(/rel\s*=\s*"?([^";]+)"?/i)?.[1]?.trim().toLowerCase();
    if (!rel || !rel.split(/\s+/).includes("license")) continue;
    const type = part.match(/type\s*=\s*"?([^";]+)"?/i)?.[1]?.trim().toLowerCase();
    // A `rel="license"` with no type is the pre-RSL convention (a link to a human licence page).
    // Requiring the media type is what keeps us from fetching a Creative Commons HTML page and
    // reporting "malformed licence".
    if (type !== "application/rsl+xml") continue;
    return target;
  }
  return null;
}

/** `<link rel="license" type="application/rsl+xml" href="…">`, attributes in any order. */
export function licenseUrlFromHtml(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = tag.match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1]?.trim().toLowerCase();
    if (!rel || !rel.split(/\s+/).includes("license")) continue;
    const type = tag.match(/\btype\s*=\s*["']?([^"'>]+)/i)?.[1]?.trim().toLowerCase();
    if (type !== "application/rsl+xml") continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? tag.match(/\bhref\s*=\s*([^\s"'>]+)/i)?.[1];
    if (href) return href;
  }
  return null;
}

/** `<script type="application/rsl+xml">…</script>` — the document, inline in the page. */
export function inlineRslFromHtml(html: string): string | null {
  const m = html.match(
    /<script\b[^>]*\btype\s*=\s*["']application\/rsl\+xml["'][^>]*>([\s\S]*?)<\/script\s*>/i,
  );
  return m?.[1]?.trim() || null;
}

/**
 * Fetch one licence document. Https-only and guarded per its own origin.
 *
 * Returns null for "there is no usable licence here" — a 404, a body that is not RSL, a URI we
 * refuse to open. THROWS for a transport failure, and the difference is load-bearing: a caller that
 * caches "no licence" must not cache a timeout, or one flaky moment strips a publisher's consent
 * evidence from every later request for as long as the cache lives.
 */
async function fetchDoc(url: string, fetcherFor: (origin: string) => Fetcher): Promise<RslDocument | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // A `License:` directive that names http:// downgrades a licence to something anyone on the path
  // can rewrite. Refuse rather than read terms an attacker chose.
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const res = await fetcherFor(u.origin)(u.toString(), {
    headers: { accept: "application/rsl+xml, application/xml;q=0.9" },
  });
  if (!res.ok) return null;
  return parseRslOrNull(await res.text());
}

/**
 * Locate and parse the licence governing `targetUrl`.
 *
 * Returns null when the publisher publishes none — which is the common case today and is NOT a
 * failure. A caller must treat null as "no declared terms", never as "no restrictions".
 */
/**
 * The page-level channels, from a response the caller already holds — the Link header, then the
 * HTML `<link>`, then an inline document.
 *
 * Exported separately from `locateLicence` so a caller with its own cache can compose the channels
 * itself: the page-level answer is per-URL and uncacheable, while the robots-level one is per-ORIGIN
 * and answers for every URL on it. A resolver that could not tell them apart would either re-fetch
 * robots.txt for every candidate or cache a page's terms against the whole site.
 */
export async function locateFromObserved(
  targetUrl: string,
  observed: ObservedResponse,
  opts: Pick<LocateOptions, "fetcherFor"> = {},
): Promise<LocatedLicence | null> {
  const fetcherFor = opts.fetcherFor ?? defaultFetcherFor;
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return null;
  }
  const headerUrl = licenseUrlFromLinkHeader(observed.headers?.["link"]);
  if (headerUrl) {
    const abs = new URL(headerUrl, target).toString();
    const doc = await fetchDoc(abs, fetcherFor);
    if (doc) return { source: "link-header", documentUrl: abs, doc };
  }
  if (observed.body) {
    const htmlUrl = licenseUrlFromHtml(observed.body);
    if (htmlUrl) {
      const abs = new URL(htmlUrl, target).toString();
      const doc = await fetchDoc(abs, fetcherFor);
      if (doc) return { source: "html-link", documentUrl: abs, doc };
    }
    const inline = inlineRslFromHtml(observed.body);
    if (inline) {
      const doc = parseRslOrNull(inline);
      if (doc) return { source: "html-inline", doc, associationPath: target.pathname };
    }
  }
  return null;
}

/**
 * The robots.txt channel for one ORIGIN. One request that answers for every URL on it, which is
 * what makes it the cacheable half.
 *
 * Null means the origin genuinely publishes nothing (no robots.txt, no `License:` line, a licence
 * URL that 404s). A transport failure THROWS instead — see `fetchDoc`. `locateLicence` swallows
 * that for simple callers; a caching caller must not.
 */
export async function locateFromRobots(
  origin: string,
  opts: Pick<LocateOptions, "fetcherFor" | "userAgent"> = {},
): Promise<LocatedLicence | null> {
  const fetcherFor = opts.fetcherFor ?? defaultFetcherFor;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  const res = await fetcherFor(base.origin)(new URL("/robots.txt", base.origin).toString());
  if (!res.ok) return null;
  const url = licenseUrlFromRobots(await res.text(), opts.userAgent);
  if (!url) return null;
  const abs = new URL(url, base.origin).toString();
  const doc = await fetchDoc(abs, fetcherFor);
  return doc ? { source: "robots", documentUrl: abs, doc } : null;
}

/**
 * Locate and parse the licence governing `targetUrl`, across every channel.
 *
 * Returns null when the publisher publishes none — which is the common case today and is NOT a
 * failure. A caller must treat null as "no declared terms", never as "no restrictions".
 */
export async function locateLicence(
  targetUrl: string,
  opts: LocateOptions = {},
): Promise<LocatedLicence | null> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return null;
  }
  if (opts.observed) {
    const found = await locateFromObserved(targetUrl, opts.observed, opts).catch(() => null);
    if (found) return found;
  }
  // Transport failures become null here — `locateLicence` is the total, simple front door. A caller
  // that CACHES the answer calls `locateFromRobots` directly and keeps the distinction.
  const fromRobots = await locateFromRobots(target.origin, opts).catch(() => null);
  if (fromRobots) return fromRobots;

  if (opts.fetchPage && !opts.observed) {
    const fetcherFor = opts.fetcherFor ?? defaultFetcherFor;
    try {
      const res = await fetcherFor(target.origin)(target.toString());
      const link = res.header?.("link");
      return await locateFromObserved(
        targetUrl,
        { ...(link ? { headers: { link } } : {}), body: await res.text() },
        opts,
      );
    } catch {
      return null;
    }
  }
  return null;
}
