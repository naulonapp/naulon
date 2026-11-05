import type { JwkSet } from "@naulon/shared";

/** Why a fetch of the gate's keys failed. `transient` marks a failure of the gate (no answer, a 5xx,
 *  a body that is not JSON) apart from a 4xx, which is a misconfigured key URL and must never become
 *  a free pass. */
export interface JwksFailure {
  reason: string;
  transient: boolean;
}

/**
 * The minting gate's published keys, fetched once and shared. Keys belong to the gate, not to a
 * site, so every engine that talks to one gate (one site, or every site on a platform) can hold one
 * of these. A failed refresh keeps the last good set (stale-if-error).
 */
export interface JwksCache {
  readonly url: string;
  /** The keys when they were fetched within the TTL, else undefined. */
  fresh(): JwkSet | undefined;
  /** The last keys ever fetched, however old. */
  last(): JwkSet | undefined;
  /** Fetch now. One fetch in flight at a time. Resolves to null on success, or why it failed. */
  refresh(): Promise<JwksFailure | null>;
}

export function jwksCache(
  url: string,
  opts: { ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): JwksCache {
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 600_000;
  let cached: JwkSet | undefined;
  let fetchedAt = 0;
  let inflight: Promise<JwksFailure | null> | undefined;
  return {
    url,
    fresh: () => (cached && clock() - fetchedAt < ttl ? cached : undefined),
    last: () => cached,
    refresh(): Promise<JwksFailure | null> {
      inflight ??= (async (): Promise<JwksFailure | null> => {
        try {
          const res = await doFetch(url, { headers: { accept: "application/json" } });
          if (!res.ok) return { reason: `-> HTTP ${res.status}`, transient: res.status >= 500 };
          cached = (await res.json()) as JwkSet;
          fetchedAt = clock();
          return null;
        } catch (err) {
          return { reason: `unreachable (${err instanceof Error ? err.message : String(err)})`, transient: true };
        }
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
