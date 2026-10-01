/**
 * The gate's crawler-ranges document, cached per isolate. The middleware asks only after a UA has
 * named a crawler, so a person's request never starts a fetch.
 */
import { compileRanges, parseRangesDocument, type CompiledRanges } from "@naulon/shared";

export interface CrawlerRangesSource {
  /** What is on hand now. Starts a background fetch when the copy is stale; never waits for it. */
  current(): CompiledRanges | null;
}

export function httpCrawlerRangesSource(
  url: string,
  o: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; retryMs?: number } = {},
): CrawlerRangesSource {
  const doFetch = o.fetchImpl ?? fetch;
  const clock = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 3_600_000;
  const retry = o.retryMs ?? 60_000;
  let compiled: CompiledRanges | null = null;
  let nextAt = 0;
  let inFlight = false;

  const load = async (): Promise<void> => {
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
      const doc = res.ok ? parseRangesDocument(await res.json()) : null;
      if (doc) {
        compiled = compileRanges(doc);
        nextAt = clock() + ttl;
      } else {
        nextAt = clock() + retry;
      }
    } catch {
      nextAt = clock() + retry;
    } finally {
      inFlight = false;
    }
  };

  return {
    current() {
      if (!inFlight && clock() >= nextAt) {
        inFlight = true;
        void load();
      }
      return compiled;
    },
  };
}
