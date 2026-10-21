/**
 * Marks a request as a rejected guess at a credential, so authThrottle charges it.
 *
 * The throttle used to infer a guess from the response: a 401 on a request carrying an
 * Authorization header. That is right for HTTP Basic and blind to every other place a
 * password is checked. The sign-in form carries its password in the body, and the
 * password-change form answers a wrong current password with a redirect, so neither was
 * ever charged. A handler that checks a secret says so here instead of hoping the status
 * code gives it away.
 */
import type { Context } from "hono";

const rejected = new WeakSet<Request>();

export function markRejectedGuess(c: Context): void {
  rejected.add(c.req.raw);
}

export function isRejectedGuess(c: Context): boolean {
  return rejected.has(c.req.raw);
}
