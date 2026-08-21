/**
 * The CSRF guard on every state-changing console route.
 *
 * It lived inline in server.ts and moved here when the login form needed it too. Its
 * reasoning also had to change, which is the real reason this is its own file:
 *
 * Under HTTP Basic, "no Origin and no Referer" meant "not a browser", and a non-browser
 * caller carries no ambient credential — so the request was allowed through. That was
 * correct for Basic.
 *
 * A COOKIE is ambient. Once a session cookie exists, an unattributed state-changing
 * request from a browser is exactly the shape CSRF takes, and the old fallback would wave
 * it through. So a session-authenticated write demands a matching Origin (or Referer) and
 * refuses when there is none; every browser that can hold a `SameSite=Strict` cookie
 * sends `Origin` on a POST, so this costs a real operator nothing.
 *
 * The lenient path stays for the MACHINE credential, where the premise still holds: a
 * curl or a CI job sends no Origin, holds no cookie, and cannot be made to act on
 * someone else's behalf by a web page.
 */
import type { Context, MiddlewareHandler } from "hono";

export type OriginPolicy = "strict" | "lenient";

export interface OriginVerdict {
  ok: boolean;
  /** Set when refused — the response body, already safe to show. */
  refusal?: string;
}

export function checkOrigin(c: Context, policy: OriginPolicy): OriginVerdict {
  /*
   * `Sec-Fetch-Site` first, and it is not a nicety — an Origin-based check CANNOT work on
   * this console. It sends `Referrer-Policy: no-referrer`, and Chrome then serialises the
   * Origin header of a form POST as the literal string `null` (and sends no Referer at
   * all), so the old check saw "null", failed `new URL()`, and answered 403 to a perfectly
   * ordinary sign-in. Measured 2026-08-21 by submitting the real form in a real browser;
   * every request-level test passed throughout, because a test client sends neither header
   * the way a browser does.
   *
   * `Sec-Fetch-Site` is also the better signal on its own terms: the browser sets it, page
   * content cannot forge it, and it states the relationship directly instead of leaving us
   * to compare two strings and hope the port is spelled the same way.
   */
  const site = c.req.header("Sec-Fetch-Site");
  if (site) {
    // `none` is a user-typed URL or a bookmark — not a cross-site request.
    if (site === "same-origin" || site === "none") return { ok: true };
    return { ok: false, refusal: `cross-origin request refused (Sec-Fetch-Site: ${site})` };
  }

  const host = c.req.header("Host");
  const raw = c.req.header("Origin");
  // An opaque origin. Under `no-referrer` this is what a same-origin POST looks like to a
  // server, so it cannot be treated as proof of an attack — but it is not proof of safety
  // either, and a browser old enough to send it is old enough to lack Sec-Fetch-Site. Under
  // the strict policy that combination is refused; the message names the real cause.
  if (raw === "null") {
    if (policy === "strict") {
      return {
        ok: false,
        refusal:
          "refused: this request carries an opaque Origin and no Sec-Fetch-Site, so the\n" +
          "console cannot tell a sign-in from a cross-site post. Use a current browser.\n",
      };
    }
    return { ok: true };
  }
  const source = raw ?? c.req.header("Referer");
  if (!source) {
    if (policy === "strict") {
      return {
        ok: false,
        refusal:
          "refused: this request changes state and carries a session cookie, but no Origin.\n" +
          "A browser always sends one; a script should authenticate with DASHBOARD_AUTH instead.\n",
      };
    }
    return { ok: true };
  }
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return { ok: false, refusal: "malformed Origin/Referer" };
  }
  if (sourceHost !== host) return { ok: false, refusal: "cross-origin request refused" };
  return { ok: true };
}

/**
 * Middleware form. The policy is resolved per request, because whether the caller holds a
 * cookie is not known until the principal is resolved — `getPolicy` reads that off the
 * context rather than being fixed at mount time.
 */
export function sameOrigin(getPolicy: (c: Context) => OriginPolicy): MiddlewareHandler {
  return async (c, next) => {
    const verdict = checkOrigin(c, getPolicy(c));
    if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);
    await next();
  };
}
