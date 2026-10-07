/**
 * Cache discipline for gateable-route decisions. Every response on a gateable
 * route is User-Agent-dependent — the same URL yields a human 200, an agent 402,
 * or a blocked 403 — so a shared cache keying on URL alone could serve a human's
 * 200 to an agent (a free read) or an agent's 402/403 to a human (a paywall on
 * the open web, the exact failure the classifier is biased against).
 * `Vary: User-Agent` partitions any compliant cache; it is MERGED into an
 * origin-set Vary, never clobbering one. Money-bearing states (402 quotes carry
 * a fresh validity window, 403 blocks, licensed rereads, paid content) also get
 * `Cache-Control: no-store` — they are per-request artifacts, not documents. The
 * human free read keeps the origin's own Cache-Control: page cacheability
 * belongs to the publisher, and Vary alone keeps agents out of that cache entry.
 * Passthrough routes (suspended, non-article, unknown-article) serve the same bytes
 * to every caller and are untouched, except a content exit (`contentExit.ts`), whose
 * answer depends on who asked.
 */
export function stampGateCacheHeaders(res: Response, opts: { noStore: boolean }): Response {
  const vary = res.headers.get("vary");
  const hasUa =
    vary
      ?.split(",")
      .some((v) => v.trim() === "*" || v.trim().toLowerCase() === "user-agent") ?? false;
  if (!hasUa) res.headers.set("Vary", vary ? `${vary}, User-Agent` : "User-Agent");
  if (opts.noStore) res.headers.set("Cache-Control", "no-store");
  return res;
}
