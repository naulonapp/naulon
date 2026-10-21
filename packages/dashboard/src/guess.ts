/**
 * What a sign-in handler learned about a request, for authThrottle to charge or remember.
 *
 * The throttle used to infer a guess from the response: a 401 on a request carrying an
 * Authorization header. That is right for HTTP Basic and blind to every other place a
 * password is checked. The sign-in form carries its password in the body, and the
 * password-change form answers a wrong current password with a redirect, so neither was
 * ever charged. A handler that checks a secret says what happened here instead of hoping the
 * status code gives it away.
 */
import type { Context } from "hono";

const rejected = new WeakMap<Request, string | undefined>();
const accepted = new WeakMap<Request, string>();

/** A wrong secret. `username` is the account it was aimed at, when the handler knows it. */
export function markRejectedGuess(c: Context, username?: string): void {
  rejected.set(c.req.raw, username);
}

export function isRejectedGuess(c: Context): boolean {
  return rejected.has(c.req.raw);
}

/** The account a rejected guess was aimed at, if the handler named one. */
export function rejectedAccount(c: Context): string | undefined {
  return rejected.get(c.req.raw);
}

/** A right secret for `username`. */
export function markSignedIn(c: Context, username: string): void {
  accepted.set(c.req.raw, username);
}

export function signedInAccount(c: Context): string | undefined {
  return accepted.get(c.req.raw);
}
