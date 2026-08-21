/**
 * The dashboard's access policy — the single place that decides whether, and to
 * whom, the ops view is served. The ops console exposes wallets, earnings, and
 * traffic; leaking that to the open internet by a stray bind is the failure mode
 * this guards. The rule, in order:
 *
 *   public flag set        → serve the PUBLIC earnings view only (wallets masked)
 *   a valid credential     → serve full ops behind HTTP Basic, wherever it is bound
 *   loopback-only reach    → serve the full private ops console (box owner only)
 *   reachable, no auth     → REFUSE. Don't start leaking; make the operator choose.
 *
 * The credential is checked BEFORE the loopback shortcut, and that order is the rule:
 * an operator who sets `DASHBOARD_AUTH` has said "ask for this", and the answer to an
 * explicit instruction is never to drop it. It used to be dropped — loopback matched
 * first, so a console started with a credential ran with none and the boot line said
 * `[private]`, which is how the operator would never find out. Loopback is not a trust
 * boundary on a box with more than one user on it (a container sharing a network
 * namespace, a dev machine with an SSH tunnel, another tenant's process): any of them
 * reaches 127.0.0.1, and the ops plane serves wallets and takes writes.
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
   * Does the console have operator ACCOUNTS? A console with accounts authenticates
   * through them, so it is as safe to expose as one with DASHBOARD_AUTH — and refusing
   * to serve it because no Basic credential is set would refuse the very deployment this
   * feature exists for (a team signing in, with no shared secret anywhere).
   */
  hasUsers?: boolean;
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

/**
 * Is this BIND address loopback-only? A different question from `isLoopbackHostname`
 * (host-guard.ts), and the two sets differ on purpose — `0.0.0.0` is every interface
 * when you bind it and a local name when it arrives in a `Host` header. Naming them
 * apart is the point: collapsing them would either make a wide bind read as private
 * (a wallet leak) or reject a legitimate local request.
 *
 * Two more notions exist, both about a URL rather than a socket or a header:
 * `content.ts`'s `isLoopbackOrigin` (may the crawler reach a private address?) and
 * `enforce/botAuth.ts`'s inline check (may a bot-auth URL point back at us?). Four
 * questions, four answers, none of them substitutable — so nothing pretends a single
 * helper covers them, and the sets are allowed to differ.
 */
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackBind = (bind: string): boolean => LOOPBACK_BINDS.has(bind.trim());

/** A usable Basic credential is exactly `user:pass`, both non-empty. */
// NOT a type predicate. It used to be `auth is string`, which taught the compiler that a
// value failing this check is `undefined` — so the "set but unreadable" case below could
// not even be written without TS narrowing it to `never`. A malformed credential is very
// much a string; the guard answers "is it USABLE", not "is it present".
export const isValidAuth = (auth: string | undefined): boolean => {
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

export function decideAccess({ bind, auth, isPublic, hasUsers = false, allowedHosts = [] }: AccessInput): AccessDecision {
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

  // Before the loopback shortcut, on purpose — see the note at the top of this file.
  // A credential that was set and then ignored is worse than no credential, because the
  // operator believes they have one.
  if (isValidAuth(auth)) {
    const why =
      external.length > 0
        ? `reachable as ${external.join(", ")} with DASHBOARD_AUTH`
        : isLoopbackBind(bind)
          ? `loopback bind (${bind}) with DASHBOARD_AUTH set`
          : "wide bind with DASHBOARD_AUTH";
    return {
      serve: true,
      mode: "authed",
      requireAuth: true,
      refuse: false,
      reason: `${why} — ops console behind HTTP Basic`,
    };
  }

  // Accounts are a credential too. Same reasoning as the branch above and the same
  // position relative to the loopback shortcut: an operator who created accounts has
  // asked to be asked, and loopback is not a boundary between users on one box.
  if (hasUsers) {
    const why =
      external.length > 0
        ? `reachable as ${external.join(", ")} with console accounts`
        : isLoopbackBind(bind)
          ? `loopback bind (${bind}) with console accounts`
          : "wide bind with console accounts";
    return {
      serve: true,
      mode: "authed",
      requireAuth: true,
      refuse: false,
      reason: `${why} — ops console behind a sign-in`,
    };
  }

  // Set, but unusable: `DASHBOARD_AUTH=ops:` with no secret, `DASHBOARD_AUTH=opspass` with
  // no colon, a value that survived a shell quoting accident. This is the SAME failure the
  // ordering note above describes, reached by a different door — the operator asked for a
  // credential, the credential could not be read, and falling through to the loopback
  // shortcut would serve the full ops console with the boot line reading `[private]`, which
  // is precisely how they would never find out. Measured 2026-08-21: it returned 200 and
  // served wallets. When a security control loses its input, refuse.
  // Empty string is UNSET (that is what a shell hands you for `DASHBOARD_AUTH=`), but any
  // other value is an attempt — including one that is only whitespace, which is a quoting
  // accident rather than a decision to run without a credential.
  if (auth !== undefined && auth !== "") {
    return {
      serve: false,
      mode: "refused",
      requireAuth: false,
      refuse: true,
      reason:
        "refusing to serve: DASHBOARD_AUTH is set but unreadable — it must be `user:secret` " +
        "with both halves non-empty. The secret is either a password or a scrypt hash from " +
        "`npm run hash -w @naulon/dashboard`. Serving anyway would run the ops console with " +
        "no credential while the boot line claimed a private one.",
    };
  }

  if (isLoopbackBind(bind) && external.length === 0) {
    return {
      serve: true,
      mode: "private",
      requireAuth: false,
      refuse: false,
      reason: `loopback bind (${bind}) — private ops console`,
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
