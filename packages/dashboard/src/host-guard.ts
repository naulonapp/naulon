/**
 * Host-header allowlist — the DNS-rebinding defense for the private console.
 *
 * The problem it solves: in private mode the dashboard binds loopback and runs with
 * NO authentication (see access.ts — that is the deliberate "box owner only" model).
 * The `sameOrigin` guard protects the write routes, but a READ route has nothing to
 * check, and "bound to 127.0.0.1" is not a defense a browser respects. A page the
 * operator visits can register a hostname with a short TTL, re-point it at
 * 127.0.0.1, and fetch the dashboard: to the browser that is same-origin, so there
 * is no preflight and no Origin to reject, and the attacker's script reads the
 * response — wallets, config, traffic, webhook URLs.
 *
 * The fix is to answer only to hostnames we expect. A rebound request necessarily
 * carries the ATTACKER's hostname in `Host` (that is what made it same-origin), so
 * an allowlist of loopback names plus whatever the operator declares kills it.
 *
 * Only PRIVATE mode is checked:
 *   - authed  — Basic auth already stops it; the browser holds no credential for the
 *               attacker's origin, so the rebound request 401s. Host-checking here
 *               would break every legitimate reverse-proxy deployment.
 *   - public  — wallets are masked and every ops route is unmounted; nothing to steal.
 */
import type { AccessMode } from "./access.ts";

/** Loopback authorities, with or without a port. `Host` never carries a scheme. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Strip the port from a `Host` value, honoring the `[::1]:8403` bracket form.
 * Returns the bare hostname, lowercased.
 */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h.slice(1) : h.slice(1, close);
  }
  // An IPv6 literal without brackets has >1 colon and carries no port.
  const firstColon = h.indexOf(":");
  if (firstColon === -1) return h;
  if (h.indexOf(":", firstColon + 1) !== -1) return h;
  return h.slice(0, firstColon);
}

/** Parse `DASHBOARD_ALLOWED_HOSTS` — comma-separated, trimmed, lowercased, no blanks. */
export function parseAllowedHosts(csv: string): string[] {
  return csv
    .split(",")
    .map((h) => hostnameOf(h))
    .filter(Boolean);
}

/**
 * May the dashboard answer a request carrying this `Host`?
 *
 * @param host    the raw `Host` header (undefined when absent)
 * @param allowed operator-declared hostnames, already parsed
 * @param mode    the access decision made at boot
 */
export function isAllowedHost(
  host: string | undefined,
  allowed: readonly string[],
  mode: AccessMode,
): boolean {
  if (mode !== "private") return true;
  if (!host) return false; // HTTP/1.1 requires Host; absent means a client we don't serve
  const name = hostnameOf(host);
  return LOOPBACK_HOSTNAMES.has(name) || allowed.includes(name);
}
