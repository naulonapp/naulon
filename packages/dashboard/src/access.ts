/**
 * The dashboard's access policy — the single place that decides whether, and to
 * whom, the ops view is served. The ops console exposes wallets, earnings, and
 * traffic; leaking that to the open internet by a stray bind is the failure mode
 * this guards. The rule, in order:
 *
 *   public flag set        → serve the PUBLIC earnings view only (wallets masked)
 *   loopback-only reach    → serve the full private ops console (box owner only)
 *   reachable + auth       → serve full ops behind HTTP Basic
 *   reachable, no auth     → REFUSE. Don't start leaking; make the operator choose.
 *
 * "Reachable" is the subtle part, and getting it from the bind address alone was a
 * hole. `DASHBOARD_BIND` describes a socket, and two real deployments have no socket
 * to describe:
 *
 *   - Serverless (the dashboard ships a Vercel entrypoint). Nothing calls `listen`,
 *     so the bind default of 127.0.0.1 survives untouched and every request looks
 *     loopback-local while the console is answering the public internet.
 *   - A reverse proxy in front of a loopback bind. Same shape: the socket really is
 *     loopback, and the exposure is entirely somewhere else.
 *
 * Both cases announce themselves the same way: the operator must name a NON-loopback
 * hostname in `DASHBOARD_ALLOWED_HOSTS` for the console to answer at all (that list
 * is the DNS-rebinding guard — see host-guard.ts). So that list, not the bind, is the
 * honest signal that strangers can reach this. Naming a public hostname on a console
 * with NO credential is refused, and the refusal names the two ways forward.
 *
 * The principle, worth keeping: when a security control loses its input, refuse —
 * never degrade to the trusting answer.
 */
import { isLoopbackHostname } from "./host-guard.ts";

export type AccessMode = "private" | "authed" | "public" | "refused";

export interface AccessInput {
  /** DASHBOARD_BIND. */
  bind: string;
  /** DASHBOARD_AUTH — "user:pass" or undefined. */
  auth: string | undefined;
  /** DASHBOARD_PUBLIC. */
  isPublic: boolean;
  /**
   * Parsed `DASHBOARD_ALLOWED_HOSTS`. Any entry that is not a loopback name means
   * the operator is deliberately fronting this console with something the outside
   * world can address, so the loopback bind stops being evidence of privacy.
   */
  allowedHosts?: readonly string[];
}

export interface AccessDecision {
  serve: boolean;
  mode: AccessMode;
  requireAuth: boolean;
  refuse: boolean;
  reason: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (bind: string): boolean => LOOPBACK.has(bind.trim());

/** A usable Basic credential is exactly `user:pass`, both non-empty. */
export const isValidAuth = (auth: string | undefined): auth is string => {
  if (!auth) return false;
  const i = auth.indexOf(":");
  return i > 0 && i < auth.length - 1;
};

/**
 * The allowed-host entries that are NOT loopback names — i.e. the hostnames that
 * only make sense if something outside this box can address the console.
 */
export const externalHosts = (allowedHosts: readonly string[] = []): string[] =>
  allowedHosts.filter((h) => !isLoopbackHostname(h));

export function decideAccess({ bind, auth, isPublic, allowedHosts = [] }: AccessInput): AccessDecision {
  if (isPublic) {
    return {
      serve: true,
      mode: "public",
      requireAuth: false,
      refuse: false,
      reason: "DASHBOARD_PUBLIC — public earnings view (wallets masked)",
    };
  }

  const external = externalHosts(allowedHosts);

  if (isLoopback(bind) && external.length === 0) {
    return {
      serve: true,
      mode: "private",
      requireAuth: false,
      refuse: false,
      reason: `loopback bind (${bind}) — private ops console`,
    };
  }

  if (isValidAuth(auth)) {
    const why = isLoopback(bind)
      ? `reachable as ${external.join(", ")} with DASHBOARD_AUTH`
      : "wide bind with DASHBOARD_AUTH";
    return {
      serve: true,
      mode: "authed",
      requireAuth: true,
      refuse: false,
      reason: `${why} — ops console behind HTTP Basic`,
    };
  }

  // Refused. The two causes need different remedies, so name the actual one: an
  // operator who reads "bind 127.0.0.1" when they are on Vercel has been told
  // something useless.
  const cause =
    external.length > 0
      ? `DASHBOARD_ALLOWED_HOSTS names a non-loopback host (${external.join(", ")}), so this ` +
        `console is reachable by anyone who can resolve that name, and it has no credential`
      : `bound to non-loopback (${bind}) with no DASHBOARD_AUTH and DASHBOARD_PUBLIC unset`;
  return {
    serve: false,
    mode: "refused",
    requireAuth: false,
    refuse: true,
    reason:
      `refusing to serve: ${cause} — it would expose payout wallets and earnings. ` +
      `Set DASHBOARD_AUTH=user:pass for the full ops console, or DASHBOARD_PUBLIC=true ` +
      `for the masked earnings page only.`,
  };
}
