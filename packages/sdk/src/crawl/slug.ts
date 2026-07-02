/**
 * crawl/slug.ts — credits-key slug derivation, mirroring the gate exactly.
 *
 * The crawler writes `credits.json[slug]`; the gate looks that exact key up via its own
 * `slugFromPath`: the first path segment AFTER a configured article prefix,
 * `^/(?:<prefixes>)/([^/?#]+)`. A slug derived any other way is an article the gate can
 * never find → it would never toll. So this is a faithful re-impl of that one function.
 */

/** Escape a string for use as a literal inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Article slug from a URL, using the publisher's prefixes. Returns the decoded slug, or
 * `null` when the path is not a gateable article (no prefix matches, or it is a gate
 * control route, or the URL is malformed). Matches the gate exactly.
 */
export function deriveSlug(url: string, prefixes: string[]): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  // Never treat the gate's own control routes as articles, whatever the prefixes are.
  if (path.startsWith("/.well-known/") || path.startsWith("/licenses/")) return null;
  const clean = prefixes.filter(Boolean);
  if (clean.length === 0) return null;
  const m = path.match(new RegExp(`^/(?:${clean.map(escapeRe).join("|")})/([^/?#]+)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}
