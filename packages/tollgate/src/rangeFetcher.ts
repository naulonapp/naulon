/**
 * Fetches every operator's published ranges and holds the merged document this gate serves at
 * /.well-known/naulon/crawler-ranges.json. Refresh is on demand and single-flight: the first read
 * after the data turns `refreshMs` old starts one background refresh and is answered from what is
 * on hand. No timer, so the same code runs under Node and a serverless adapter.
 */
import {
  applyFetch,
  compileRanges,
  CRAWLER_PROOF,
  emptySourceState,
  parseLineList,
  parseRangeFile,
  PROXY_SOURCES,
  unionOf,
  type CompiledRanges,
  type CrawlerRangesDocument,
  type FetchOutcome,
  type SourceState,
} from "@naulon/shared";

export interface RangeFetcher {
  current(): CompiledRanges | null;
  document(): CrawlerRangesDocument | null;
  refresh(): Promise<void>;
}

export interface RangeFetcherOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  disabled?: boolean;
  refreshMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

const MAX_REDIRECTS = 3;
/** While any source has never been fetched successfully (a blip at boot), try again this soon. */
const RETRY_MS = 5 * 60_000;

/** The body as text, or null once it passes `max` bytes. Reads no further than the cap. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createRangeFetcher(opts: RangeFetcherOptions = {}): RangeFetcher {
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? 6 * 3_600_000;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

  const operatorUrls = CRAWLER_PROOF.flatMap((r) => r.sources.map((url) => ({ url, lines: false })));
  const proxyUrls = Object.values(PROXY_SOURCES).flatMap((us) => us.map((url) => ({ url, lines: true })));
  const all = [...operatorUrls, ...proxyUrls];
  const states = new Map<string, SourceState>();
  const t0 = clock();
  for (const { url } of all) states.set(url, emptySourceState(url, t0));

  /** The last full refresh, and the last attempt of any kind (full or a retry of the sources that never succeeded). */
  let lastRefresh: number | null = null;
  let lastAttempt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let doc: CrawlerRangesDocument | null = null;
  let compiled: CompiledRanges | null = null;

  async function fetchOne(url: string, lines: boolean): Promise<FetchOutcome> {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // A range file decides who reads free, so every hop must be https: a plain-http hop would let
      // anyone on the path rewrite it.
      let protocol: string;
      try {
        protocol = new URL(target).protocol;
      } catch {
        return { kind: "unreachable", detail: `unparseable redirect target ${target}` };
      }
      if (protocol !== "https:") return { kind: "unreachable", detail: `refused a non-https hop to ${target}` };
      let res: Response;
      try {
        res = await doFetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json, text/plain" },
        });
      } catch (err) {
        return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { kind: "http-error", status: res.status };
        try {
          target = new URL(loc, target).toString();
        } catch {
          return { kind: "unreachable", detail: `unparseable redirect target ${loc}` };
        }
        continue;
      }
      if (!res.ok) return { kind: "http-error", status: res.status };
      let body: string | null;
      try {
        body = await readCapped(res, maxBytes);
      } catch (err) {
        return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
      }
      if (body === null) return { kind: "bad-shape", detail: `body over ${maxBytes} bytes` };
      const prefixes = lines ? parseLineList(body) : parseRangeFile(body);
      if (!prefixes) return { kind: "bad-shape", detail: "no valid prefixes in the expected shape" };
      return { kind: "ok", prefixes, finalUrl: target };
    }
    return { kind: "unreachable", detail: `more than ${MAX_REDIRECTS} redirects` };
  }

  function build(now: number): void {
    // A proxy list that has never been fetched would publish as empty, and a client reading it
    // would take that proxy's own address for the caller's: a real crawler behind it would read
    // forged. So nothing is published until every proxy source has had one good copy; until then
    // every claim, everywhere, reads unverified.
    const proxyStates = Object.values(PROXY_SOURCES).flatMap((us) => us.map((u) => states.get(u)!));
    if (proxyStates.some((st) => st.lastGoodAt === null)) {
      doc = null;
      compiled = null;
      return;
    }
    const operators = CRAWLER_PROOF.map((r) => {
      const ss = r.sources.map((u) => states.get(u)!);
      const goods = ss.map((s) => s.lastGoodAt);
      const fetchedAt = goods.length === 0 || goods.some((g) => g === null) ? null : Math.min(...(goods as number[]));
      return {
        id: r.id,
        operator: r.operator,
        fragments: [...r.fragments],
        kind: r.kind,
        forgedEligible: r.forgedEligible,
        fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
        prefixes: [...new Set(ss.flatMap((s) => unionOf(s, now)))],
      };
    });
    const proxies: Record<string, string[]> = {};
    for (const [name, urls] of Object.entries(PROXY_SOURCES)) {
      proxies[name] = [...new Set(urls.flatMap((u) => unionOf(states.get(u)!, now)))];
    }
    doc = { version: 1, generatedAt: new Date(now).toISOString(), proxies, operators, sources: [...states.values()].map((s) => s.health) };
    compiled = compileRanges(doc);
  }

  /** Fetch `which` (every source by default), apply what came back, rebuild. One at a time. */
  function run(which: typeof all, full: boolean): Promise<void> {
    if (opts.disabled) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      // One source that throws must not cost the others their copy.
      const outcomes = await Promise.all(
        which.map((s) =>
          fetchOne(s.url, s.lines).catch((err: unknown): FetchOutcome => ({ kind: "unreachable", detail: err instanceof Error ? err.message : String(err) })),
        ),
      );
      const now = clock();
      which.forEach((s, i) => states.set(s.url, applyFetch(states.get(s.url)!, outcomes[i]!, now)));
      if (full) lastRefresh = now;
      build(now);
    })().finally(() => {
      // Stamped even on failure, so a refresh that keeps failing is retried on schedule and never
      // restarted by every request.
      lastAttempt = clock();
      if (full && lastRefresh === null) lastRefresh = lastAttempt;
      inFlight = null;
    });
    return inFlight;
  }

  function refresh(): Promise<void> {
    return run(all, true);
  }

  function maybeRefresh(): void {
    if (opts.disabled) return;
    const now = clock();
    const onError = (err: unknown) => console.error("[tollgate] crawler ranges refresh failed (ignored):", err);
    if (lastRefresh === null || now >= lastRefresh + refreshMs) {
      run(all, true).catch(onError);
      return;
    }
    // Only the sources that have never had a good copy are retried early: refetching all fourteen
    // because one URL is dead would hammer every operator every five minutes for as long as it stays dead.
    const missing = all.filter((s) => states.get(s.url)!.lastGoodAt === null);
    if (missing.length > 0 && now >= (lastAttempt ?? 0) + Math.min(RETRY_MS, refreshMs)) {
      run(missing, false).catch(onError);
    }
  }

  return {
    current() {
      maybeRefresh();
      return compiled;
    },
    document() {
      maybeRefresh();
      return doc;
    },
    refresh,
  };
}
