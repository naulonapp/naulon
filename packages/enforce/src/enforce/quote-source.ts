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
  /** The resource's PATHNAME — what a per-path price rule matches against. Derivable from
   *  `resource`, and carried anyway so a source never has to parse a URL to price one. */
  path?: string;
}

export interface QuoteSource {
  quote(publisher: unknown, slug: string, kind: TollKind, ctx: QuoteContext): Promise<Quote | null>;
}

/** Wrap a publisher's own price+payees lookup. `undefined`/`null` → free read. */
export function localQuoteSource(
  fn: (publisher: unknown, slug: string, kind: TollKind, path?: string) => Promise<Quote | null | undefined>,
): QuoteSource {
  return {
    async quote(publisher, slug, kind, ctx) {
      // `ctx.path` reaches the publisher's own pricing so a self-hosting site's price rules
      // resolve exactly as the hosted gate's do. A wrapper that ignores the argument keeps
      // today's site-wide pricing, which is what every existing caller does.
      return (await fn(publisher, slug, kind, ctx.path)) ?? null;
    },
  };
}

/** What a failed quote lookup reports. `status` is 0 when the request never got a response. */
export interface QuoteLookupFailure {
  status: number;
  resource: string;
  reason: string;
}

/** The default reporter: one line per distinct status, at most once every 5 minutes, so a broken key
 *  is impossible to miss in a log without flooding it at request rate. */
function defaultOnFailure(): (f: QuoteLookupFailure) => void {
  const lastAt = new Map<number, number>();
  return (f) => {
    const now = Date.now();
    const prev = lastAt.get(f.status) ?? 0;
    if (now - prev < 300_000) return;
    lastAt.set(f.status, now);
    console.warn(
      `[naulon] quote lookup FAILED (${f.reason}) for ${f.resource} — the toll is failing OPEN:`
        + " every agent reads free until this is fixed. Check NAULON_API_KEY and the control plane.",
    );
  };
}

/**
 * Defer pricing to the hosted `GET /quote?resource=…` (nln_live_ authed). A 204
 * means "no toll" → `null` (free). A 200 returns the `Quote`. Never a wallet key.
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 *
 * Two things this must never do, and they pull in opposite directions:
 *
 *   - It must never BLOCK a reader because our lookup broke. A 401/403/5xx, or a control plane
 *     that is simply unreachable, returns `null` — "no toll" — so the page still renders. A throw
 *     used to escape this function, through `decide()`, and out of the publisher's middleware:
 *     an outage on our side turned into a 500 on THEIR site, for humans included, which is a far
 *     worse failure than serving a read for free.
 *   - It must never be SILENT about it. Failing open is invisible by construction — the origin
 *     answers 200, the reader is happy, and the money quietly stops. In prod on 2026-08-04 a
 *     publisher's key stopped resolving (its tenant had been closed and recreated) and every
 *     priced article was served free for a day; nothing in either runtime said a word. So every
 *     failure is reported: `onFailure`, or a throttled console.warn.
 *
 * A 204 is NOT a failure — it is the deliberate don't-gate signal — and is never reported.
 */
export function httpQuoteSource(
  quoteUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  onFailure: (failure: QuoteLookupFailure) => void = defaultOnFailure(),
): QuoteSource {
  return {
    async quote(_publisher, slug, kind, ctx) {
      // slug+kind let the cloud price directly (decide() already derived the slug);
      // resource is carried for catalog lookups keyed on the full URL.
      const q = new URLSearchParams({ resource: ctx.resource, slug, kind });
      let res: Response;
      try {
        res = await fetchImpl(`${quoteUrl}?${q}`, { headers: { authorization: `Bearer ${apiKey}` } });
      } catch (err) {
        // Unreachable control plane (DNS, TLS, timeout). Fail open — but loudly.
        onFailure({ status: 0, resource: ctx.resource, reason: err instanceof Error ? err.message : "unreachable" });
        return null;
      }
      if (res.status === 204) return null; // no toll → free read (deliberate, not a failure)
      if (!res.ok) {
        // fail-open: a quote lookup miss must never gate a reader. Reported, never swallowed.
        onFailure({ status: res.status, resource: ctx.resource, reason: `HTTP ${res.status}` });
        return null;
      }
      try {
        return (await res.json()) as Quote;
      } catch (err) {
        // A 200 whose body is not a Quote is a broken control plane, not a free article.
        onFailure({ status: res.status, resource: ctx.resource, reason: err instanceof Error ? err.message : "unparseable quote" });
        return null;
      }
    },
  };
}
