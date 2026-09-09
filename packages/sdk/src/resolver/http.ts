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
 *
 * EXPORTED because it is the one implementation. The whole-slug encode existed in four places —
 * this resolver, the `naulon check` CLI, and both credits probes in the control plane — and fixing
 * only the resolver made the probe's own comment ("exactly how the gate builds the leaf it will
 * fetch") false. Anything composing `${base}/credits/${slug}` must call this, not re-spell it.
 */
export function encodeSlugPath(slug: string): string {
  // OUTER slashes are the slug's own shape, not traversal, and refusing them broke the two modes
  // that produce them: `slugFromSitePath` returns the full pathname (`/blog/post`) and
  // `slugFromPath` under `depth:"rest"` keeps a trailing one. Strip one of each, then refuse the
  // segments that could climb: `.`, `..`, and an INTERIOR empty one (`a//b`).
  const segments = slug.replace(/^\//, "").replace(/\/$/, "").split("/");
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
      // A slug SHAPE must never become a 503. Everything else on this path fails toward a free
      // read (404 ⇒ undefined), and `resolve()` is called from `quote()` with no try/catch above
      // it — so a throw here would surface as "naulon is temporarily unavailable" to every agent
      // on that tenant. An unusable slug is one this contract cannot address: treat it as absent.
      let leaf: string;
      try {
        leaf = encodeSlugPath(slug);
      } catch {
        return undefined;
      }
      const res = await fetch(`${base}/credits/${leaf}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`credits lookup failed: ${res.status} ${res.statusText}`);
      // Validate the upstream response before any wallet here becomes a payTo.
      return parseCredits(await res.json(), `credits for "${slug}" from ${base}`);
    },
  };
}
