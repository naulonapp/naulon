/**
 * crawl/fetcher.ts — the guarded `Fetcher` the crawl orchestrator hands every adapter.
 *
 * It enforces three things before a byte is sent, so an adapter that derives a URL can only
 * ever reach the one host the publisher owns:
 *   1. VERIFIED-ORIGIN-ONLY — the request host must equal the configured origin host.
 *   2. SSRF CIDR block — the resolved IP must not be private/loopback/link-local (`net.ts`).
 *   3. ANTI-DNS-REBIND — the socket connects to the IP the guard validated, via the connect-
 *      time `guardedLookup` (no TOCTOU between the check and the connect).
 *
 * A `fetchImpl` is injectable for tests (the stub path skips the node-http machinery — moot for
 * a fake — but STILL enforces origin + https).
 */
import { guardedRequest } from "./net.ts";
import type { Fetcher, FetchResult } from "./types.ts";

/** Cap on a fetched body — feeds/sitemaps are text, but a hostile origin must not OOM us. */
const MAX_BODY = 8 * 1024 * 1024; // 8 MiB

export interface GuardedFetcherOpts {
  /** The verified origin, `scheme://host[:port]`. The fetcher rejects any other host. */
  origin: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Dev-only escape hatch: permit private/loopback + http (so a local fixture origin works).
   *  NEVER set in production — it disables the SSRF block. Defaults false. */
  allowPrivate?: boolean;
  /** Injected fetch (tests/fakes). Absent → the real node-http guarded path. */
  fetchImpl?: typeof fetch;
}

/** Build the guarded fetcher bound to one origin. */
export function makeGuardedFetcher(opts: GuardedFetcherOpts): Fetcher {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const allowPrivate = opts.allowPrivate ?? false;

  let originHost: string;
  try {
    originHost = new URL(opts.origin).host; // host = hostname[:port]
  } catch {
    throw new Error(`crawl fetcher: invalid origin ${opts.origin}`);
  }

  return async (url, init) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`crawl fetcher: invalid url ${url}`);
    }
    // (1) verified-origin-only — the host must match the proven origin exactly.
    if (u.host !== originHost) {
      throw new Error(`crawl fetcher: off-origin host blocked (${u.host} ≠ ${originHost})`);
    }
    // https only, unless the dev escape hatch is on (local http fixtures).
    if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) {
      throw new Error(`crawl fetcher: url must be https (${u.protocol})`);
    }

    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {
      "user-agent": "naulon-crawl/1 (+catalog-draft)",
      accept:
        "application/json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      ...init?.headers,
    };

    // Injected fetch (tests) — origin + https already enforced; TOCTOU is moot for a fake.
    if (opts.fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await opts.fetchImpl(url, {
          method,
          headers,
          ...(method === "POST" && init?.body !== undefined ? { body: init.body } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
        const out: Record<string, string> = {};
        res.headers?.forEach?.((v: string, k: string) => {
          out[k.toLowerCase()] = v;
        });
        return wrapResponse(res.status, res.ok, await res.text().catch(() => ""), out);
      } finally {
        clearTimeout(timer);
      }
    }

    // Real path: the shared guarded request (connect-time lookup, so there is no rebind window).
    // A body past the cap is cut rather than refused, as a feed or sitemap still parses up to it.
    const raw = await guardedRequest(url, {
      method,
      headers,
      ...(method === "POST" && init?.body !== undefined ? { body: init.body } : {}),
      timeoutMs,
      maxBytes: MAX_BODY,
      overflow: "truncate",
      allowPrivate,
    });
    if (!raw.ok) throw new Error(`crawl fetcher: ${raw.detail}`);
    return wrapResponse(raw.status, raw.status >= 200 && raw.status < 300, raw.body, raw.headers);
  };
}

/** A `FetchResult` over a buffered body. `json()` throws on non-JSON (the adapter narrows). */
function wrapResponse(status: number, ok: boolean, body: string, headers: Record<string, string> = {}): FetchResult {
  return {
    ok,
    status,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body) as unknown;
    },
  };
}
