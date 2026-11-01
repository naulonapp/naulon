/**
 * Resolve publishers from a platform over HTTP.
 *
 * A platform that hosts many sites (a blogging service, a CMS host) answers
 * `GET <url>?host=<host>` with a `PublisherRecord` for that host, or 404 when it does not toll it.
 * The gate validates the answer, caches it per host, and keeps serving the last good record while
 * the platform is unreachable or answering garbage, so a platform outage never changes what the
 * gate does for a site it already knew.
 *
 * `Host` is chosen by whoever sends the request, so nothing here may grow with it: a host that is
 * not hostname syntax never reaches the platform, concurrent lookups of one host share one fetch,
 * and the cache is a bounded LRU covering absent hosts as well as known ones.
 */
import { isBareHostname, type PublisherConfig, type PublisherResolver } from "@naulon/shared";
import { parsePublisherRecord, publisherFromRecord } from "./publisherRecord.ts";

export interface HttpPublisherResolverOptions {
  /** The platform endpoint. The host is appended as `?host=`. */
  url: string;
  /** Sent as `Authorization: Bearer <key>`. */
  key: string;
  /** How long a record is trusted before it is fetched again. Default 60 s. */
  ttlMs?: number;
  /** Per-request timeout. Default 2 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Hosts kept in the cache, known and absent together. Default 10,000. */
  maxEntries?: number;
}

interface Entry {
  config: PublisherConfig | undefined;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 10_000;
/** How long a failed lookup for a host with no last good record is remembered, so an outage costs
 *  the platform one request per host per window rather than one per gate request. */
const FAILURE_TTL_MS = 5_000;

/**
 * The host a platform is asked about: lowercase, one trailing dot dropped, a bare hostname with an
 * optional port, or undefined. The port is kept, unlike the ingress, because a platform may key its
 * sites by `host:port` (a local development server does).
 */
export function platformHostOf(raw: string): string | undefined {
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase());
  if (!m || !m[1]) return undefined;
  const name = m[1].endsWith(".") ? m[1].slice(0, -1) : m[1];
  if (!isBareHostname(name)) return undefined;
  if (m[2] === undefined) return name;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? `${name}:${port}` : undefined;
}

/** A platform resolver, with its cache sizes for diagnostics. */
export interface HttpPublisherResolver extends PublisherResolver {
  stats(): { cached: number; warned: number; inflight: number };
}

export function httpPublisherResolver(opts: HttpPublisherResolverOptions): HttpPublisherResolver {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Looked up per call, so instrumentation installed after boot (tracing, a proxy agent) applies.
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.error(`[tollgate] ${m}`));
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Map iteration order is insertion order, so re-inserting on every hit makes the first key the
  // least recently used one.
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<PublisherConfig | undefined>>();
  const warned = new Set<string>();

  const remember = (host: string, entry: Entry) => {
    cache.delete(host);
    cache.set(host, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      warned.delete(oldest);
    }
  };

  const warnOnce = (host: string, message: string) => {
    if (warned.has(host)) return;
    // Bounded like the cache: past the cap the set starts over, which costs a repeated log line,
    // never memory.
    if (warned.size >= maxEntries) warned.clear();
    warned.add(host);
    log(`platform record for ${host} ignored, serving the last good one: ${message}`);
  };

  async function fetchRecord(host: string): Promise<{ kind: "found"; config: PublisherConfig } | { kind: "absent" } | { kind: "failed"; reason: string }> {
    const target = `${opts.url}${opts.url.includes("?") ? "&" : "?"}host=${encodeURIComponent(host)}`;
    let res: Response;
    try {
      res = await doFetch(target, { headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 404) return { kind: "absent" };
    if (!res.ok) return { kind: "failed", reason: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "failed", reason: "body is not JSON" };
    }
    const parsed = parsePublisherRecord(body);
    if (!parsed.ok) return { kind: "failed", reason: parsed.error };
    if (!parsed.record.hosts.map((h) => h.toLowerCase()).includes(host)) {
      return { kind: "failed", reason: "record does not list this host" };
    }
    return { kind: "found", config: publisherFromRecord(parsed.record) };
  }

  async function refresh(host: string, cached: Entry | undefined): Promise<PublisherConfig | undefined> {
    const result = await fetchRecord(host);
    if (result.kind === "found") {
      warned.delete(host);
      remember(host, { config: result.config, expiresAt: now() + ttl });
      return result.config;
    }
    if (result.kind === "absent") {
      remember(host, { config: undefined, expiresAt: now() + ttl });
      return undefined;
    }
    warnOnce(host, result.reason);
    if (cached) {
      remember(host, { config: cached.config, expiresAt: now() + ttl });
      return cached.config;
    }
    remember(host, { config: undefined, expiresAt: now() + Math.min(ttl, FAILURE_TTL_MS) });
    return undefined;
  }

  return {
    async resolve(rawHost: string) {
      const host = platformHostOf(rawHost);
      if (host === undefined) return undefined;
      const cached = cache.get(host);
      if (cached && cached.expiresAt > now()) {
        remember(host, cached);
        return cached.config;
      }
      const pending = inflight.get(host);
      if (pending) return pending;
      const run = refresh(host, cached).finally(() => inflight.delete(host));
      inflight.set(host, run);
      return run;
    },
    stats: () => ({ cached: cache.size, warned: warned.size, inflight: inflight.size }),
  };
}
