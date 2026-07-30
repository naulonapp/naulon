/**
 * Per-client rate limiting for the gate — a DoS backstop.
 *
 * The tollgate does real work per request (classify, resolve credits, verify a
 * payment), so an unthrottled flood is a cheap way to exhaust it. The bucket state
 * machine and the client-identity rule both live in `@naulon/shared`
 * (`rateLimitCore.ts` / `clientIdentity.ts`) because the operator console needs the
 * same two, and a second copy of a limiter is a second set of off-by-ones. What is
 * left here is the hono glue: pull the header, pull the socket peer, answer 429.
 *
 * In-memory + single-process. Behind multiple instances, either pin clients to an
 * instance or move the buckets to a shared store.
 *
 * When the caller cannot be identified at all, this middleware FAILS OPEN rather
 * than filing everyone under one placeholder key. Sharing a bucket would let a
 * single client spend the whole allowance and have the limiter deny every other
 * reader — the backstop becomes the outage. Failing open matches the gate's standing
 * posture (see the fail-open error boundary in app.ts): a naulon-side gap must never
 * turn a free human read into an error page. It warns once so the operator can fix
 * the cause, which is virtually always TRUST_PROXY.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  createRateLimiter,
  createUnidentifiedWarner,
  getConfig,
  resolveClientIdentity,
} from "@naulon/shared";

const cfg = getConfig();

const limiter = createRateLimiter({
  rpm: cfg.RATE_LIMIT_RPM,
  burst: cfg.RATE_LIMIT_BURST,
});

const warnOnce = createUnidentifiedWarner("rate limit");

/**
 * The socket peer, or undefined. `getConnInfo` needs a node socket and throws under
 * a serverless adapter or `app.request()` — absent is a real answer, not an error.
 */
function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** Hono middleware. No-op when RATE_LIMIT_RPM=0. */
export function rateLimit(): MiddlewareHandler {
  if (!limiter.enabled) {
    return async (_c, next) => next();
  }
  return async (c, next) => {
    const who = resolveClientIdentity({
      xff: c.req.header("x-forwarded-for"),
      peer: peerOf(c),
      trustProxy: cfg.TRUST_PROXY,
      hops: cfg.TRUST_PROXY_HOPS,
    });
    if (!who.ok) {
      warnOnce(who.reason);
      return next();
    }
    const { allowed, retryAfter } = limiter.take(who.key);
    if (!allowed) {
      return c.json({ error: "rate limit exceeded" }, 429, {
        "Retry-After": String(Math.max(1, retryAfter)),
      });
    }
    return next();
  };
}
