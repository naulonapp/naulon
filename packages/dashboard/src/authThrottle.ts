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
import { createRateLimiter, getConfig, resolveClientIdentity } from "@naulon/shared";

const cfg = getConfig();

/**
 * The bucket every unidentifiable caller shares.
 *
 * The gate's request limiter fails OPEN here instead, and that is right for the gate
 * and wrong for this. The reason it fails open is amplification: its budget is charged
 * on every request, so one shared bucket lets a single caller spend the whole allowance
 * and have the limiter deny every reader — the backstop becomes the outage.
 *
 * This budget charges only rejected guesses. A legitimate operator is never charged,
 * however hard they click, so the premise of the amplification argument does not hold
 * here, and copying the fail-open would be copying a conclusion past its reason. Failing
 * open on an auth control means HTTP Basic with no lockout at all — the credential
 * guessable at wire speed, forever, with a warning in a log nobody reads.
 *
 * `resolveClientIdentity` now treats a missing socket peer as evidence of a proxy and
 * reads the forwarded address, so a real deployment lands here only when it has neither
 * — which is close to nothing. That is what makes the trade cheap: guessers sharing this
 * bucket can hold the console at 429 for one refill, and a paused ops VIEW (the gate keeps
 * tolling and settling regardless) is a smaller loss than a console compromise, which is
 * wallets, config and the write path. The refusal below names the cause and the one-line
 * fix, so the lockout reads as a misconfiguration rather than a dead end.
 *
 * The leading space in the key is load-bearing: forwarded entries are trimmed and a peer
 * address cannot contain one, so no caller can reach this bucket by claiming its name.
 */
const SHARED_UNIDENTIFIED_KEY = " unidentified";

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
    // Unidentifiable ⇒ one shared budget, never no budget. See the note above for why
    // this diverges from the gate's fail-open.
    const key = who.ok ? who.key : SHARED_UNIDENTIFIED_KEY;

    const budget = limiter.peek(key);
    if (!budget.allowed) {
      const wait = Math.max(1, budget.retryAfter);
      return c.text(
        who.ok
          ? `naulon dashboard: too many failed sign-ins from your address.\n\n` +
              `Try again in ${wait}s. If you are the operator and locked yourself out,\n` +
              `the credential is DASHBOARD_AUTH in the environment this process was started with.\n`
          : `naulon dashboard: too many failed sign-ins, and this deployment cannot tell\n` +
              `callers apart — so the budget is shared and someone else may have spent it.\n\n` +
              `Try again in ${wait}s. To meter per client instead, set TRUST_PROXY=true (and\n` +
              `TRUST_PROXY_HOPS to the number of proxies in front) so the forwarded address\n` +
              `is used. The credential itself is DASHBOARD_AUTH in this process's environment.\n`,
        429,
        { "Retry-After": String(wait) },
      );
    }

    await next();

    // Charge a rejected GUESS, which is not the same thing as a 401.
    //
    // Basic auth begins with a 401: a browser has no credential to send until the
    // challenge arrives, so the first request of every legitimate sign-in is rejected by
    // design. Charging those made the budget fire on the operator — three unauthenticated
    // requests from their own address (a page, its favicon, a health probe) spent the
    // default burst, and the correct credential then met a 429 before basicAuth ever saw
    // it. Verified: the credential was refused on the fourth request of a plain walk.
    //
    // A guesser must present something to guess, so requiring an Authorization header
    // costs the attacker nothing they can avoid and costs the operator nothing at all.
    if (c.res.status === 401 && c.req.header("authorization")) limiter.take(key);
  };
}
