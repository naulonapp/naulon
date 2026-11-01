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
import type { PublisherConfig, PublisherResolver } from "@naulon/shared";
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
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercase, drop one trailing dot, and refuse anything that is not `hostname[:port]`. */
export function normalizeHost(raw: string): string | undefined {
  const lower = raw.trim().toLowerCase();
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(lower);
  if (!m || !m[1]) return undefined;
  const name = m[1].endsWith(".") ? m[1].slice(0, -1) : m[1];
  if (name.length === 0 || name.length > 253 || !name.split(".").every((l) => LABEL.test(l))) return undefined;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return undefined;
  return m[2] !== undefined ? `${name}:${m[2]}` : name;
}

export function httpPublisherResolver(opts: HttpPublisherResolverOptions): PublisherResolver {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
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
    return undefined;
  }

  return {
    async resolve(rawHost: string) {
      const host = normalizeHost(rawHost);
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
  };
}
