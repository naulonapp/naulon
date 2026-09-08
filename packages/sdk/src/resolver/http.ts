/**
 * The HTTP credits resolver — fetch `${apiUrl}/credits/:slug` from your CMS/API.
 * This is the canonical implementation the multi-tenant control plane previously
 * duplicated verbatim; it now lives here once.
 */
import { parseCredits } from "../contract/credits.ts";
import type { CreditsResolver } from "./types.ts";

/**
 * Encode a slug for the credits path WITHOUT destroying its hierarchy.
 *
 * `encodeURIComponent(slug)` turns every `/` into `%2F`, which most servers reject before the app
 * ever sees it — Apache answers 404 for `2026%2F09%2F08%2Fpost` while serving `2026/09/08/post`
 * fine. A 404 here is the deliberate "read this one free" signal, so a publisher whose slugs carry
 * a slash was silently untollable and BOTH sides looked healthy. WordPress's default permalink is
 * `/%year%/%monthnum%/%day%/%postname%/`, so that is the stock configuration, not an edge case.
 *
 * Encoding per SEGMENT keeps the separator meaningful and still escapes everything inside a
 * segment. The traversal refusal is why the whole-slug encode existed: `.`/`..`/empty segments are
 * rejected outright rather than encoded, so a slug can never climb out of `${base}/credits/`.
 */
function encodeSlugPath(slug: string): string {
  const segments = slug.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`credits slug has an unusable path segment: "${slug}"`);
    }
  }
  return segments.map(encodeURIComponent).join("/");
}

export function httpResolver(apiUrl: string, token?: string): CreditsResolver {
  const base = apiUrl.replace(/\/$/, "");
  return {
    async resolve(slug) {
      const res = await fetch(`${base}/credits/${encodeSlugPath(slug)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`credits lookup failed: ${res.status} ${res.statusText}`);
      // Validate the upstream response before any wallet here becomes a payTo.
      return parseCredits(await res.json(), `credits for "${slug}" from ${base}`);
    },
  };
}
