/**
 * The dashboard's access policy — the single place that decides whether, and to
 * whom, the ops view is served. The ops console exposes wallets, earnings, and
 * traffic; leaking that to the open internet by a stray bind is the failure mode
 * this guards. The rule, in order:
 *
 *   public flag set      → serve the PUBLIC earnings view only (wallets masked)
 *   bound to loopback    → serve the full private ops console (box owner only)
 *   bound wide + auth     → serve full ops behind HTTP Basic
 *   bound wide, no auth   → REFUSE. Don't start leaking; make the operator choose.
 */

export type AccessMode = "private" | "authed" | "public" | "refused";

export interface AccessInput {
  /** DASHBOARD_BIND. */
  bind: string;
  /** DASHBOARD_AUTH — "user:pass" or undefined. */
  auth: string | undefined;
  /** DASHBOARD_PUBLIC. */
  isPublic: boolean;
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

export function decideAccess({ bind, auth, isPublic }: AccessInput): AccessDecision {
  if (isPublic) {
    return { serve: true, mode: "public", requireAuth: false, refuse: false, reason: "DASHBOARD_PUBLIC — public earnings view (wallets masked)" };
  }
  if (isLoopback(bind)) {
    return { serve: true, mode: "private", requireAuth: false, refuse: false, reason: `loopback bind (${bind}) — private ops console` };
  }
  if (isValidAuth(auth)) {
    return { serve: true, mode: "authed", requireAuth: true, refuse: false, reason: "wide bind with DASHBOARD_AUTH — ops console behind HTTP Basic" };
  }
  return {
    serve: false,
    mode: "refused",
    requireAuth: false,
    refuse: true,
    reason: `refusing to serve: bound to non-loopback (${bind}) with no DASHBOARD_AUTH and DASHBOARD_PUBLIC unset — would leak wallets/earnings. Set one, or bind 127.0.0.1.`,
  };
}
