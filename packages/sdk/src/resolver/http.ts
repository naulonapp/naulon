/**
 * The HTTP credits resolver — fetch `${apiUrl}/credits/:slug` from your CMS/API.
 * This is the canonical implementation the multi-tenant control plane previously
 * duplicated verbatim; it now lives here once.
 */
import { parseCredits } from "../contract/credits.ts";
import type { CreditsResolver } from "./types.ts";

export function httpResolver(apiUrl: string, token?: string): CreditsResolver {
  const base = apiUrl.replace(/\/$/, "");
  return {
    async resolve(slug) {
      const res = await fetch(`${base}/credits/${encodeURIComponent(slug)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`credits lookup failed: ${res.status} ${res.statusText}`);
      // Validate the upstream response before any wallet here becomes a payTo.
      return parseCredits(await res.json(), `credits for "${slug}" from ${base}`);
    },
  };
}
