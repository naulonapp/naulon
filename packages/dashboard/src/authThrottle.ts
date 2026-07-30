/**
 * A budget for FAILED sign-ins on the ops console.
 *
 * `DASHBOARD_AUTH` is HTTP Basic, and Basic has no notion of lockout: once the console
 * is bound anywhere a stranger can reach, the credential can be guessed at whatever
 * rate the network allows, forever, and nothing in the app notices. The console shows
 * payout wallets, so that is the one unauthenticated surface worth metering.
 *
 * Why this and not a blanket request limiter: a blanket limiter has to be loose enough
 * for a real operator (a page load is a burst of assets, API calls and an SSE stream),
 * and anything that loose is useless against guessing. Charging only the 401s inverts
 * it — a legitimate operator is never metered at all, however hard they click, while a
 * guesser spends its whole budget in ten tries and waits.
 *
 * Broader flood protection for the console stays the reverse proxy's job, which is
 * this project's standing posture for exposing it (docs/operating.md).
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

const warnOnce = createUnidentifiedWarner("failed sign-in budget");

/** Same absent-is-an-answer handling as the gate's limiter — serverless has no socket. */
function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** Overridable for tests; production passes nothing and takes the config. */
export interface AuthThrottleOptions {
  rpm?: number;
  burst?: number;
  trustProxy?: boolean;
  hops?: number;
  now?: () => number;
}

/**
 * Mount BEFORE `basicAuth`. Refuses while the caller's failure budget is empty, and
 * charges a token only when the response that came back was a 401.
 */
export function authThrottle(opts: AuthThrottleOptions = {}): MiddlewareHandler {
  const trustProxy = opts.trustProxy ?? cfg.TRUST_PROXY;
  const hops = opts.hops ?? cfg.TRUST_PROXY_HOPS;
  const limiter = createRateLimiter({
    rpm: opts.rpm ?? cfg.DASHBOARD_AUTH_FAIL_RPM,
    burst: opts.burst ?? cfg.DASHBOARD_AUTH_FAIL_BURST,
    now: opts.now,
  });
  if (!limiter.enabled) {
    return async (_c, next) => next();
  }
  return async (c, next) => {
    const who = resolveClientIdentity({
      xff: c.req.header("x-forwarded-for"),
      peer: peerOf(c),
      trustProxy,
      hops,
    });
    if (!who.ok) {
      warnOnce(who.reason);
      return next();
    }

    const budget = limiter.peek(who.key);
    if (!budget.allowed) {
      const wait = Math.max(1, budget.retryAfter);
      return c.text(
        `naulon dashboard: too many failed sign-ins from your address.\n\n` +
          `Try again in ${wait}s. If you are the operator and locked yourself out,\n` +
          `the credential is DASHBOARD_AUTH in the environment this process was started with.\n`,
        429,
        { "Retry-After": String(wait) },
      );
    }

    await next();

    // Charge only a rejection. A correct credential costs nothing, so no amount of
    // legitimate use can lock the operator out of their own console.
    if (c.res.status === 401) limiter.take(who.key);
  };
}
