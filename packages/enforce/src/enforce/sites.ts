/**
 * `naulonSites`: one integration for a platform that hosts many sites.
 *
 * Each site's owner connects their own site (see `naulonConnect`) and the platform stores the
 * credential that comes back. `credentialFor(host)` returns it, or null for a site that has not
 * turned naulon on. A site without a credential is never touched: there is no platform-wide
 * credential to fall back to, so nobody is tolled who did not opt in. A credential acts only for the
 * site its owner approved; the gate refuses it anywhere else.
 *
 * A credential may name its own gate: a writer who runs their own gate connects to it, and their
 * site is tolled there. That URL came from a writer, so every request to a gate other than the one
 * this platform configured goes through the guarded fetch (https only, no private addresses, no
 * redirects followed).
 *
 * Every site gets its own engine: its policy, its quotes, its reports, all under its credential. A
 * gate's keys and crawler ranges belong to that gate, so every engine on one gate shares one copy.
 * Engines are kept for the `maxSites` most recently active sites; a site pushed out is rebuilt on
 * its next request, and its policy is fetched again.
 */
import { DEFAULT_GATE, originOf } from "@naulon/shared";
import { guardedFetch } from "@naulon/sdk/net";
import type { NaulonConnect } from "../connect/connect.ts";
import { naulonMiddleware, type GateCaches, type MiddlewareResult, type NaulonMiddlewareOptionsBase } from "./middleware.ts";
import { httpPublisherConfigSource } from "./config-source.ts";
import { httpQuoteSource } from "./quote-source.ts";
import { httpObservationSink } from "./observation-sink.ts";
import { httpCrawlerRangesSource } from "./rangesSource.ts";
import { jwksCache } from "./jwks-cache.ts";

/** A stored credential, on the platform's gate, or on a gate its owner chose. */
export type SiteCredential = string | { credential: string; gate?: string };

/** What a platform answers for a host: what its owner connected, or nothing. May be async. */
export type CredentialFor = (host: string) => SiteCredential | null | undefined | Promise<SiteCredential | null | undefined>;

export interface NaulonSitesOptions
  extends Omit<NaulonMiddlewareOptionsBase, "quote" | "verifyUrl" | "apiKey" | "config" | "publisher" | "observe" | "gateCaches"> {
  /** The gate a credential with no gate of its own uses. Default: the hosted naulon gate. */
  gate?: string;
  credentialFor: CredentialFor;
  /** Answers the connect paths (`/.well-known/naulon-*`) before the toll runs. */
  connect?: NaulonConnect;
  /** How long an answer from `credentialFor` is reused for a host. Default 30 s: a changed or
   *  revoked credential lands within it, and the lookup runs about once per host per interval. */
  credentialTtlMs?: number;
  /** Engines kept for this many recently active sites. Default 1,000. */
  maxSites?: number;
  /** Report the verdicts only this process sees to each site's dashboard. Default on. */
  observe?: boolean;
}

const HOST_CACHE_MAX = 10_000;
const PASS: MiddlewareResult = { response: null };

interface Resolved {
  gate: string;
  credential: string;
}

export function naulonSites(opts: NaulonSitesOptions): (req: Request) => Promise<MiddlewareResult> {
  const home = originOf(opts.gate ?? DEFAULT_GATE);
  if (!home) throw new Error(`naulonSites: gate must be an https URL, got ${JSON.stringify(opts.gate)}`);
  const clock = opts.now ?? Date.now;
  const credentialTtl = opts.credentialTtlMs ?? 30_000;
  const maxSites = opts.maxSites ?? 1_000;
  const { gate: _gate, credentialFor, credentialTtlMs: _ttl, maxSites: _max, observe, connect, ...shared } = opts;
  // A test injects its own fetch for every gate. Otherwise the platform's own gate gets the plain
  // fetch, and a gate a writer named gets the guarded one.
  const guarded = guardedFetch();
  const fetchFor = (gate: string): typeof fetch => opts.fetchImpl ?? (gate === home ? fetch : guarded);

  const gateCaches = new Map<string, GateCaches>();
  const cachesFor = (gate: string): GateCaches => {
    const held = gateCaches.get(gate);
    if (held) return held;
    const doFetch = fetchFor(gate);
    const made: GateCaches = {
      jwks: jwksCache(gate === home && opts.licenseVerification?.jwksUrl ? opts.licenseVerification.jwksUrl : `${gate}/.well-known/naulon-jwks.json`, {
        ...(opts.licenseVerification?.cacheTtlMs ? { ttlMs: opts.licenseVerification.cacheTtlMs } : {}),
        fetchImpl: doFetch,
        now: clock,
      }),
      ranges:
        opts.crawlerRanges === false
          ? null
          : httpCrawlerRangesSource(gate === home && opts.crawlerRanges?.url ? opts.crawlerRanges.url : `${gate}/.well-known/naulon/crawler-ranges.json`, {
              fetchImpl: doFetch,
              now: clock,
              ...(opts.crawlerRanges?.ttlMs ? { ttlMs: opts.crawlerRanges.ttlMs } : {}),
            }),
    };
    gateCaches.set(gate, made);
    return made;
  };

  // Host answers and engines are both insertion-ordered maps used as LRUs: a hit is re-inserted.
  const hosts = new Map<string, { at: number; site: Resolved | null }>();
  const engines = new Map<string, (req: Request) => Promise<MiddlewareResult>>();
  const warned = new Set<string>();
  const warnOnce = (kind: string, message: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.error(`[naulon] ${message}`);
  };

  const resolve = (raw: SiteCredential | null | undefined, host: string): Resolved | null => {
    if (raw === null || raw === undefined) return null;
    const credential = (typeof raw === "string" ? raw : raw.credential)?.trim();
    if (!credential) return null;
    const named = typeof raw === "string" ? undefined : raw.gate;
    const gate = named ? originOf(named) : home;
    if (!gate) {
      warnOnce(`gate:${host}`, `the gate saved for ${host} is not an https URL; that site is served untouched`);
      return null;
    }
    return { gate, credential };
  };

  const siteOf = async (host: string): Promise<Resolved | null> => {
    const hit = hosts.get(host);
    if (hit && clock() - hit.at < credentialTtl) {
      hosts.delete(host);
      hosts.set(host, hit);
      return hit.site;
    }
    let site: Resolved | null = null;
    try {
      site = resolve(await credentialFor(host), host);
    } catch (err) {
      warnOnce("credentialFor", `credentialFor threw; the site is served untouched: ${err instanceof Error ? err.message : String(err)}`);
    }
    hosts.delete(host);
    hosts.set(host, { at: clock(), site });
    while (hosts.size > HOST_CACHE_MAX) hosts.delete(hosts.keys().next().value as string);
    return site;
  };

  const engineFor = ({ gate, credential }: Resolved): ((req: Request) => Promise<MiddlewareResult>) => {
    const id = `${gate} ${credential}`;
    const held = engines.get(id);
    if (held) {
      engines.delete(id);
      engines.set(id, held);
      return held;
    }
    const doFetch = fetchFor(gate);
    const engine = naulonMiddleware({
      ...shared,
      fetchImpl: doFetch,
      config: httpPublisherConfigSource(`${gate}/_naulon/enforce-config`, credential, { fetchImpl: doFetch, now: clock }),
      quote: httpQuoteSource(`${gate}/_naulon/quote`, credential, doFetch),
      verifyUrl: `${gate}/_naulon/verify`,
      apiKey: credential,
      // A JWKS URL or issuer the platform set describes its own gate, never a gate a writer chose.
      licenseVerification: gate === home ? { ...(opts.licenseVerification ?? {}) } : { ...(opts.licenseVerification?.cacheTtlMs ? { cacheTtlMs: opts.licenseVerification.cacheTtlMs } : {}) },
      gateCaches: cachesFor(gate),
      ...(observe === false ? {} : { observe: httpObservationSink(`${gate}/_naulon/observe`, credential, doFetch) }),
    });
    engines.set(id, engine);
    while (engines.size > maxSites) engines.delete(engines.keys().next().value as string);
    return engine;
  };

  return async (req: Request): Promise<MiddlewareResult> => {
    if (connect) {
      const answered = await connect.wellKnown(req);
      if (answered) return { response: answered };
    }
    let host: string;
    try {
      host = new URL(req.url).host.toLowerCase();
    } catch {
      return PASS;
    }
    const site = await siteOf(host);
    if (site === null) return PASS; // this site has not turned naulon on
    return engineFor(site)(req);
  };
}

/** The environment a single site reads, by the same names the Python package reads. */
export interface SiteEnv {
  NAULON_GATE?: string;
  NAULON_KEY?: string;
  NAULON_ENABLED?: string;
}

export interface NaulonSiteOptions extends Omit<NaulonSitesOptions, "credentialFor" | "gate"> {
  /** The gate this site connected to. Default `NAULON_GATE`, then the hosted naulon gate. */
  gate?: string;
  /** The credential connect returned. Default `NAULON_KEY`. None means nothing is tolled. */
  credential?: string | null;
  /** Default `NAULON_ENABLED`; unset is on, and `0`, `false`, `no`, `off` turn it off. */
  enabled?: boolean;
  /** Where the defaults above are read. Default `process.env` where there is one. */
  env?: SiteEnv;
}

const offWords = new Set(["0", "false", "no", "off", ""]);

/**
 * `naulonSite`: the toll for one site, configured like the Python package: by `NAULON_KEY` (the
 * credential connect returned) and, for a self-hosted gate, `NAULON_GATE`. Everything else comes
 * from the gate, so a price or scope change needs no deploy.
 *
 *   app.use(naulonNode(naulonSite()));
 *
 * It is `naulonSites` with one credential for every host the process serves. The gate answers only
 * for the host that credential was approved for: a request on any other hostname (a preview URL,
 * `www.`) gets no quote, so its reader reads free, and the refusal is reported once.
 */
export function naulonSite(opts: NaulonSiteOptions = {}): (req: Request) => Promise<MiddlewareResult> {
  const env: SiteEnv = opts.env ?? ((globalThis as { process?: { env?: SiteEnv } }).process?.env ?? {});
  const { credential: given, enabled: givenEnabled, env: _env, gate: givenGate, ...rest } = opts;
  const enabled = givenEnabled ?? !offWords.has((env.NAULON_ENABLED ?? "on").trim().toLowerCase());
  const credential = (given === undefined ? env.NAULON_KEY : given)?.trim() || null;
  const fromEnv = givenGate === undefined && !!env.NAULON_GATE?.trim();
  const gate = givenGate ?? (env.NAULON_GATE?.trim() || DEFAULT_GATE);
  // Connect is how a site gets its credential, so its paths are answered whether or not the toll is
  // on: a site with no key yet must still prove itself to its gate.
  const connectOnly = async (req: Request): Promise<MiddlewareResult> => {
    const answered = rest.connect ? await rest.connect.wellKnown(req) : null;
    return answered ? { response: answered } : PASS;
  };
  if (!enabled) return connectOnly;
  // A value typed into a deploy's environment must not take the site down at boot. A gate passed
  // in code is the developer's own, and is refused loudly by `naulonSites` like any other option.
  if (fromEnv && !originOf(gate)) {
    console.error("[naulon] NAULON_GATE must be an https URL, so nothing is tolled.");
    return connectOnly;
  }
  if (!credential) {
    console.error("[naulon] NAULON_KEY is not set, so nothing is tolled. Connect this site (naulonConnect) and set the credential it returns.");
    return connectOnly;
  }
  return naulonSites({ ...rest, gate, credentialFor: () => credential });
}
