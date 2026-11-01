/**
 * Resolve publishers from a platform over HTTP.
 *
 * A platform that hosts many sites (a blogging service, a CMS host) answers
 * `GET <url>?host=<host>` with a `PublisherRecord` for that host, or 404 when it does not toll it.
 * The gate validates the answer, caches it per host, and keeps serving the last good record while
 * the platform is unreachable or answering garbage, so a platform outage never changes what the
 * gate does for a site it already knew.
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
}

interface Entry {
  config: PublisherConfig | undefined;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export function httpPublisherResolver(opts: HttpPublisherResolverOptions): PublisherResolver {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.error(`[tollgate] ${m}`));
  const cache = new Map<string, Entry>();
  const warned = new Set<string>();

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

  return {
    async resolve(rawHost: string) {
      const host = rawHost.toLowerCase();
      const cached = cache.get(host);
      if (cached && cached.expiresAt > now()) return cached.config;
      const result = await fetchRecord(host);
      if (result.kind === "found") {
        warned.delete(host);
        cache.set(host, { config: result.config, expiresAt: now() + ttl });
        return result.config;
      }
      if (result.kind === "absent") {
        cache.set(host, { config: undefined, expiresAt: now() + ttl });
        return undefined;
      }
      warnOnce(host, result.reason);
      if (cached) {
        cache.set(host, { config: cached.config, expiresAt: now() + ttl });
        return cached.config;
      }
      return undefined;
    },
  };
}
