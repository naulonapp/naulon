/**
 * A pluggable price+payees source for the in-app middleware. `decide()` asks it
 * for a `Quote` per gated slug; returning `null` means "no toll — serve free"
 * (the same don't-gate signal the gate's own pricing uses).
 *
 * Two implementations ship:
 *   - `localQuoteSource` — the publisher's OWN data (Phase 1a). A site that
 *     already knows its authors/prices (e.g. a credits API) wraps that lookup.
 *   - `httpQuoteSource` — the hosted cloud `/quote` (Phase 1b). A site with no
 *     local catalog defers to the scraper catalog the control plane maintains.
 *
 * Custody-free either way: a quote carries `payTo` addresses, never a key.
 */
import type { Quote, TollKind } from "../decide.ts";

/** Extra request context a source may need (the hosted source keys off the URL). */
export interface QuoteContext {
  /** The full resource URL being decided (what the hosted `/quote` looks up). */
  resource: string;
}

export interface QuoteSource {
  quote(publisher: unknown, slug: string, kind: TollKind, ctx: QuoteContext): Promise<Quote | null>;
}

/** Wrap a publisher's own price+payees lookup. `undefined`/`null` → free read. */
export function localQuoteSource(
  fn: (publisher: unknown, slug: string, kind: TollKind) => Promise<Quote | null | undefined>,
): QuoteSource {
  return {
    async quote(publisher, slug, kind) {
      return (await fn(publisher, slug, kind)) ?? null;
    },
  };
}

/**
 * Defer pricing to the hosted `GET /quote?resource=…` (nln_live_ authed). A 204
 * means "no toll" → `null` (free). A 200 returns the `Quote`. Never a wallet key.
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export function httpQuoteSource(
  quoteUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): QuoteSource {
  return {
    async quote(_publisher, slug, kind, ctx) {
      // slug+kind let the cloud price directly (decide() already derived the slug);
      // resource is carried for catalog lookups keyed on the full URL.
      const q = new URLSearchParams({ resource: ctx.resource, slug, kind });
      const res = await fetchImpl(`${quoteUrl}?${q}`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (res.status === 204) return null; // no toll → free read
      if (!res.ok) return null; // fail-open: a quote lookup miss must never gate a reader
      return (await res.json()) as Quote;
    },
  };
}
