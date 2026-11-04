/**
 * `naulonSites`: one integration for a platform that hosts many sites.
 *
 * Each site's owner has their own naulon account and pastes their own key into the platform.
 * `keyFor(host)` returns that key, or null for a site that has not turned naulon on. A site without
 * a key is never touched: there is no platform-wide key to fall back to, so nobody is tolled who did
 * not opt in. A key reaches only the hosts its owner verified; the gate refuses it anywhere else.
 *
 * Every site gets its own engine (its policy, its quotes, its reports, all under its key). The
 * gate's keys and crawler ranges belong to the gate, so every engine shares one copy. Engines are
 * kept for the `maxSites` most recently active sites; a site pushed out is rebuilt on its next
 * request, and its policy is fetched again.
 */
import { naulonMiddleware, type GateCaches, type MiddlewareResult, type NaulonMiddlewareOptionsBase } from "./middleware.ts";
import { httpPublisherConfigSource } from "./config-source.ts";
import { httpQuoteSource } from "./quote-source.ts";
import { httpObservationSink } from "./observation-sink.ts";
import { httpCrawlerRangesSource } from "./rangesSource.ts";
import { jwksCache } from "./jwks-cache.ts";

/** What a platform answers for a host: the key its owner saved, or nothing. May be async. */
export type KeyFor = (host: string) => string | null | undefined | Promise<string | null | undefined>;

export interface NaulonSitesOptions
  extends Omit<NaulonMiddlewareOptionsBase, "quote" | "verifyUrl" | "apiKey" | "config" | "publisher" | "observe" | "gateCaches"> {
  /** The gate's base URL, e.g. `https://gate.naulon.app` or your own. */
  gate: string;
  keyFor: KeyFor;
  /** How long an answer from `keyFor` is reused for a host. Default 30 s: a changed or revoked key
   *  lands within it, and the platform's lookup runs about once per host per interval. */
  keyTtlMs?: number;
  /** Engines kept for this many recently active sites. Default 1,000. */
  maxSites?: number;
  /** Report the verdicts only this process sees to each site's dashboard. Default on. */
  observe?: boolean;
}

const HOST_CACHE_MAX = 10_000;
const PASS: MiddlewareResult = { response: null };

export function naulonSites(opts: NaulonSitesOptions): (req: Request) => Promise<MiddlewareResult> {
  const gate = opts.gate.replace(/\/+$/, "");
  const clock = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const keyTtl = opts.keyTtlMs ?? 30_000;
  const maxSites = opts.maxSites ?? 1_000;
  const { gate: _gate, keyFor, keyTtlMs: _ttl, maxSites: _max, observe, ...shared } = opts;

  const gateCaches: GateCaches = {
    jwks: jwksCache(opts.licenseVerification?.jwksUrl ?? `${gate}/.well-known/naulon-jwks.json`, {
      ...(opts.licenseVerification?.cacheTtlMs ? { ttlMs: opts.licenseVerification.cacheTtlMs } : {}),
      fetchImpl: doFetch,
      now: clock,
    }),
    ranges:
      opts.crawlerRanges === false
        ? null
        : httpCrawlerRangesSource(opts.crawlerRanges?.url ?? `${gate}/.well-known/naulon/crawler-ranges.json`, {
            fetchImpl: doFetch,
            now: clock,
            ...(opts.crawlerRanges?.ttlMs ? { ttlMs: opts.crawlerRanges.ttlMs } : {}),
          }),
  };

  // Host answers and engines are both insertion-ordered maps used as LRUs: a hit is re-inserted.
  const hosts = new Map<string, { at: number; key: string | null }>();
  const engines = new Map<string, (req: Request) => Promise<MiddlewareResult>>();
  let warned = false;

  const keyOf = async (host: string): Promise<string | null> => {
    const hit = hosts.get(host);
    if (hit && clock() - hit.at < keyTtl) {
      hosts.delete(host);
      hosts.set(host, hit);
      return hit.key;
    }
    let key: string | null = null;
    try {
      const raw = await keyFor(host);
      key = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(`[naulon] keyFor threw; the site is served untouched: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    hosts.delete(host);
    hosts.set(host, { at: clock(), key });
    while (hosts.size > HOST_CACHE_MAX) hosts.delete(hosts.keys().next().value as string);
    return key;
  };

  const engineFor = (key: string): ((req: Request) => Promise<MiddlewareResult>) => {
    const held = engines.get(key);
    if (held) {
      engines.delete(key);
      engines.set(key, held);
      return held;
    }
    const engine = naulonMiddleware({
      ...shared,
      config: httpPublisherConfigSource(`${gate}/_naulon/enforce-config`, key, { fetchImpl: doFetch, now: clock }),
      quote: httpQuoteSource(`${gate}/_naulon/quote`, key, doFetch),
      verifyUrl: `${gate}/_naulon/verify`,
      apiKey: key,
      licenseVerification: { ...(opts.licenseVerification ?? {}) },
      gateCaches,
      ...(observe === false ? {} : { observe: httpObservationSink(`${gate}/_naulon/observe`, key, doFetch) }),
    });
    engines.set(key, engine);
    while (engines.size > maxSites) engines.delete(engines.keys().next().value as string);
    return engine;
  };

  return async (req: Request): Promise<MiddlewareResult> => {
    let host: string;
    try {
      host = new URL(req.url).host.toLowerCase();
    } catch {
      return PASS;
    }
    const key = await keyOf(host);
    if (key === null) return PASS; // this site has not turned naulon on
    return engineFor(key)(req);
  };
}
