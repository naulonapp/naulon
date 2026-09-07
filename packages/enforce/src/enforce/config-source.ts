/**
 * Where the in-app enforcer gets its ENFORCEMENT CONFIG — the five facts `decide()`
 * reads off a `PublisherConfig` *before* it knows whether a request pays: what is in
 * scope, who reads free, who is refused outright, who is charged despite reading
 * free by default, and which identity a licence must carry.
 *
 * It exists because the only alternative is a literal in the publisher's own source,
 * and a literal cannot track a dashboard. Measured on a live site on 2026-09-02: the
 * control plane held `crawlerPolicy.charge = ["oai-searchbot"]` and
 * `gateScope.mode = "site"`, while the site's own middleware held a hand-written
 * `{ articlePrefixes: ["articles"] }` and no policy at all. Consequences, both silent:
 * an indexer the publisher had explicitly set to CHARGE read every article for free,
 * and only `/articles/*` tolled while the dashboard said the whole site did. Neither
 * half was broken. They were two copies of one fact, and only one of them was editable.
 *
 * The fleet-proxied path never had this problem — it resolves the publisher per request
 * from the tenant record. This restores the same property to the in-app path, which is
 * the whole point of the seam: in-app enforcement must differ from proxied enforcement
 * in WHERE the decision runs, never in WHAT it decides.
 *
 * Not here, deliberately:
 *   - **The price.** That is the quote's, per slug, and it already travels with the
 *     settlement network it must be paid on. Two owners of one money fact is how a 402
 *     ends up advertising a chain the settle path does not use.
 *   - **Any secret.** The document is derived from the tenant record by the control
 *     plane and carries only what a 402 already tells the world anyway.
 */
import { externalUrl, getConfig } from "@naulon/shared";
import type { CrawlerPolicy, PublisherConfig } from "@naulon/shared";
import type { X402Manifest } from "../discoverability.ts";

/**
 * Exactly the fields the in-app `decide()` reads off a publisher before pricing.
 *
 * Deliberately a `Pick`, not a hand-listed interface: `decide()` reading a sixth field
 * one day must not silently leave this behind, and the compiler is the only reviewer
 * that will notice. Every field stays optional — the control plane omits what a tenant
 * has not set, and an absent key must not overwrite a local default with `undefined`.
 */
export type PublisherEnforcementConfig = Partial<
  Pick<
    PublisherConfig,
    "articlePrefixes" | "gateScope" | "licenseIdentity" | "seoAllowlist" | "crawlerPolicy"
  >
>;

/** What the control plane hands an in-app runtime so it can speak for this publisher. */
export interface PublisherConfigDocument {
  /** The five decision inputs. */
  enforcement: PublisherEnforcementConfig;
  /**
   * The publisher's `/.well-known/x402` manifest, built by the control plane from the
   * same tenant record. Carried here because the 402's `Link: rel="payment"` header
   * advertises that path on every challenge, and an in-app runtime has no way to build
   * the manifest itself — it holds no price and no network. Serving a 404 there tells an
   * agent the toll is misconfigured at the exact moment it was trying to pay.
   */
  manifest?: X402Manifest;
}

/** Extra request context the source needs — the same shape `QuoteSource` takes. */
export interface ConfigContext {
  /** The full resource URL being decided; its host selects the publisher. */
  resource: string;
}

export interface PublisherConfigSource {
  load(ctx: ConfigContext): Promise<PublisherConfigDocument | null>;
}

/** What a failed config lookup reports. `status` is 0 when the request never got a response. */
export interface ConfigLookupFailure {
  status: number;
  host: string;
  reason: string;
  /** True when a previously-loaded document is still being served in its place. */
  servingStale: boolean;
}

/**
 * The default reporter: one line per distinct status, at most once every 5 minutes.
 *
 * A stale-serving failure and a cold one are different emergencies and say so. Cold is the
 * loud one: with no document, nothing is in scope, so the site tolls NOTHING — every agent
 * reads free while both runtimes answer 200. That is the same invisible-by-construction
 * failure `httpQuoteSource` was hardened against, and it is reported the same way.
 */
function defaultOnFailure(): (f: ConfigLookupFailure) => void {
  const lastAt = new Map<number, number>();
  return (f) => {
    const now = Date.now();
    const prev = lastAt.get(f.status) ?? 0;
    if (now - prev < 300_000) return;
    lastAt.set(f.status, now);
    console.warn(
      f.servingStale
        ? `[naulon] enforcement config refresh FAILED (${f.reason}) for ${f.host} — serving the last`
          + " known-good config. Policy edits made in the dashboard are NOT in effect yet."
        : `[naulon] enforcement config lookup FAILED (${f.reason}) for ${f.host} — the toll is failing`
          + " OPEN: nothing is in scope, so every agent reads free until this is fixed."
          + " Check NAULON_API_KEY and the control plane.",
    );
  };
}

export interface HttpConfigSourceOptions {
  /** How long a loaded document is served before a refresh is attempted. Default 5 min. */
  ttlMs?: number;
  /**
   * How long a FAILED lookup is remembered before another is attempted. Default 30s.
   *
   * Without it a control plane returning 401 is re-asked on every single request — a
   * broken key turns into a request-rate outbound flood from the publisher's runtime,
   * which is a worse failure than the one it is reporting.
   */
  retryAfterMs?: number;
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Where a failure is reported. Default: a throttled `console.warn`. */
  onFailure?: (failure: ConfigLookupFailure) => void;
}

interface CacheEntry {
  doc: PublisherConfigDocument | null;
  /** When the held value stops being authoritative. */
  freshUntil: number;
  /** In-flight refresh, so N concurrent requests make ONE fetch. */
  inFlight?: Promise<void>;
}

/** Drop `undefined` values so a spread of this document can never blank a local default. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Narrow the wire document to the fields this version knows, discarding anything else.
 *
 * The control plane is deployed independently of the publisher's app, so it WILL at some
 * point serve a field this SDK has never heard of. Spreading an unknown key straight onto
 * a `PublisherConfig` is how a future `originAuthSecret` — or anything else that must never
 * leave the fleet — would end up inside a publisher's request handler by accident.
 */
function narrow(body: unknown): PublisherConfigDocument | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { enforcement?: unknown }).enforcement;
  const e = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const manifest = (body as { manifest?: unknown }).manifest;
  return {
    enforcement: defined({
      articlePrefixes: Array.isArray(e["articlePrefixes"]) ? (e["articlePrefixes"] as string[]) : undefined,
      gateScope: (typeof e["gateScope"] === "object" && e["gateScope"] !== null
        ? e["gateScope"]
        : undefined) as PublisherEnforcementConfig["gateScope"],
      licenseIdentity: typeof e["licenseIdentity"] === "string" ? e["licenseIdentity"] : undefined,
      seoAllowlist: Array.isArray(e["seoAllowlist"]) ? (e["seoAllowlist"] as string[]) : undefined,
      crawlerPolicy: (typeof e["crawlerPolicy"] === "object" && e["crawlerPolicy"] !== null
        ? e["crawlerPolicy"]
        : undefined) as CrawlerPolicy | undefined,
    }),
    ...(typeof manifest === "object" && manifest !== null ? { manifest: manifest as X402Manifest } : {}),
  };
}

/**
 * Load the enforcement config from the hosted `GET /_naulon/enforce-config?resource=…`
 * (`nln_live_` authed), cached per host with stale-if-error.
 *
 * Three properties this must hold at once, and they pull against each other:
 *
 *   - **Never block a reader.** Every failure resolves to `null` or to the last known-good
 *     document. A throw here would escape through `decide()` and out of the publisher's
 *     middleware as a 500 on THEIR site, for humans included — a far worse outcome than
 *     serving a read for free.
 *   - **Never be silent about it.** See `defaultOnFailure`.
 *   - **Never be a per-request fetch.** The document changes when a human edits a dashboard,
 *     so a 5-minute TTL is generous; the cost of getting this wrong is a network round trip
 *     added to every page view of a live site.
 */
export function httpPublisherConfigSource(
  configUrl: string,
  apiKey: string,
  opts: HttpConfigSourceOptions = {},
): PublisherConfigSource {
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 300_000;
  const retryAfterMs = opts.retryAfterMs ?? 30_000;
  const onFailure = opts.onFailure ?? defaultOnFailure();
  // Per host: one publisher's runtime may serve several (apex + www, or a staging alias),
  // and they are separate tenants' configs as far as the control plane is concerned.
  const cache = new Map<string, CacheEntry>();

  async function refresh(host: string, resource: string, entry: CacheEntry): Promise<void> {
    const hadDoc = entry.doc !== null;
    const fail = (status: number, reason: string): void => {
      // Hold the stale document rather than dropping it: a control plane blip must not
      // silently switch a publisher's toll off. `retryAfterMs`, not `ttlMs`, so a failing
      // lookup is retried sooner than a healthy one is refreshed.
      entry.freshUntil = clock() + retryAfterMs;
      onFailure({ status, host, reason, servingStale: hadDoc });
    };
    let res: Response;
    try {
      res = await doFetch(`${configUrl}?resource=${encodeURIComponent(resource)}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      fail(0, err instanceof Error ? err.message : "unreachable");
      return;
    }
    if (!res.ok) {
      fail(res.status, `HTTP ${res.status}`);
      return;
    }
    let doc: PublisherConfigDocument | null;
    try {
      doc = narrow(await res.json());
    } catch (err) {
      fail(res.status, err instanceof Error ? err.message : "unparseable config");
      return;
    }
    if (doc === null) {
      fail(res.status, "config body was not an object");
      return;
    }
    entry.doc = doc;
    entry.freshUntil = clock() + ttlMs;
  }

  return {
    async load(ctx) {
      let host: string;
      try {
        host = new URL(ctx.resource).host;
      } catch {
        return null;
      }
      let entry = cache.get(host);
      if (!entry) {
        entry = { doc: null, freshUntil: 0 };
        cache.set(host, entry);
      }
      if (clock() < entry.freshUntil) return entry.doc;
      // Single-flight: concurrent requests on a cold or expired entry share one fetch.
      if (!entry.inFlight) {
        const e = entry;
        e.inFlight = refresh(host, ctx.resource, e).finally(() => {
          delete e.inFlight;
        });
      }
      await entry.inFlight;
      return entry.doc;
    },
  };
}

/**
 * A fixed enforcement config — for a self-hosted single-tenant gate, a test, or local
 * development against no control plane. Named `static` rather than `local` because that
 * is the property that matters: it cannot track anything, and choosing it is choosing
 * to maintain it by hand.
 */
export function staticPublisherConfigSource(doc: PublisherConfigDocument): PublisherConfigSource {
  return { load: async () => doc };
}

/**
 * A request handler for the publisher's `/.well-known/x402`, served from the same
 * cached document the toll decides on.
 *
 * Every 402 this middleware emits carries `Link: </.well-known/x402>; rel="payment"`.
 * A fleet-proxied host has always answered there; an in-app host answered 404, because
 * nothing in the publisher's app knew the manifest existed. An agent following the one
 * pointer we give it, at the one moment it is trying to pay us, found nothing there.
 *
 * `Cache-Control` is short and public: the manifest is the same for every caller and
 * changes when a human edits a dashboard, so an edge may hold it, briefly.
 */
export function serveX402Manifest(
  source: PublisherConfigSource,
): (req: Request) => Promise<Response> {
  return async (req) => {
    // The same "what URL is this really" the middleware uses, not `req.url`: behind a
    // TLS-terminating proxy the raw request says `http://` and, on some platforms, an
    // internal host — which would key the config cache under a host the control plane has
    // never heard of, and 404 the manifest on a correctly configured site.
    const cfg = getConfig();
    const resource = externalUrl(req, { trustProxy: cfg.TRUST_PROXY, hops: cfg.TRUST_PROXY_HOPS });
    const doc = await source.load({ resource });
    if (!doc?.manifest) {
      // No document, or a control plane that did not build one: 404 is the honest answer,
      // and it is what this path already returned. Never synthesise a manifest locally —
      // an in-app runtime holds no price and no network, so anything it invented would be
      // a guess advertised as terms.
      return new Response(JSON.stringify({ error: "no manifest" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(doc.manifest), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60, s-maxage=300",
      },
    });
  };
}
