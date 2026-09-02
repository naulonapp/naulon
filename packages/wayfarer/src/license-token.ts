/**
 * OLP licence tokens the agent currently holds, and the one place they are put on the wire.
 *
 * RSL's licence-server obligation ends with a token presented to the ORIGIN as
 * `Authorization: License <token>` — the Crawler Authorization Protocol. Every request this agent
 * makes goes through `agentFetch`, so the header is attached there and nowhere else: there are four
 * places in `buyer.ts` alone that build request headers, and a token that has to be remembered at
 * each of them is a token that will be forgotten at one. Same argument as `spendGate` — one
 * implementation, or the rule is only as good as the last call site somebody added.
 *
 * Tokens are RESOURCE-scoped: `/token` is called with the `<content url>` pattern the licence sat
 * under, so one token covers every URL that pattern admits on that origin. Held in memory for the
 * life of the process, keyed by origin + pattern, and never written to disk — it is a bearer
 * credential for somebody else's content.
 */
import { matchesPattern, specificity } from "@naulon/sdk/rsl";

interface Held {
  origin: string;
  /** The `content@url` pattern the token was issued against (RFC 9309). */
  resource: string;
  token: string;
  /** Epoch ms, or null when the server said it does not expire. */
  expiresAt: number | null;
}

const held: Held[] = [];

/**
 * Remember a token for one origin + resource pattern.
 *
 * Replaces any token already held for the same pair, so a re-acquisition after an expiry does not
 * leave the stale one to be matched first.
 */
export function rememberLicenseToken(entry: Held): void {
  const i = held.findIndex((h) => h.origin === entry.origin && h.resource === entry.resource);
  if (i === -1) held.push(entry);
  else held[i] = entry;
}

/** Forget everything. Tests, and a session ending. */
export function clearLicenseTokens(): void {
  held.length = 0;
}

/**
 * The token to present for this URL, or null.
 *
 * Most specific pattern wins, matching how the terms themselves were resolved — a token issued for
 * `/papers/*` must beat one issued for `/`, or an agent presents the broader licence for a resource
 * the publisher scoped more narrowly.
 */
export function licenseTokenFor(url: string, now: number = Date.now()): string | null {
  let origin: string;
  let path: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    path = u.pathname;
  } catch {
    return null;
  }
  let best: Held | null = null;
  for (const h of held) {
    if (h.origin !== origin) continue;
    if (h.expiresAt !== null && h.expiresAt <= now) continue;
    if (!matchesPattern(h.resource, path)) continue;
    if (best === null || specificity(h.resource) > specificity(best.resource)) best = h;
  }
  return best?.token ?? null;
}
