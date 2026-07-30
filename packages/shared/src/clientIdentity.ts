/**
 * Who is this request FROM — the one owner of client identity for rate limiting.
 *
 * A per-client limiter is only as good as its notion of "client". Two ways to get
 * that wrong, and both turn a DoS backstop into a DoS lever:
 *
 *   1. Trust the WRONG END of X-Forwarded-For. The header is a left-to-right trail:
 *      each hop APPENDS what it saw. So the leftmost entry is whatever the original
 *      caller claimed — attacker-controlled, and a forged value buys its own private
 *      bucket. The entry our own trusted proxy appended is at the RIGHT. Counting
 *      from the right is the only way to land on an address a hop we trust actually
 *      observed.
 *
 *   2. Collapse everyone into ONE bucket. If the client can't be identified and the
 *      code substitutes a constant, every caller shares one allowance: any single
 *      client can exhaust it and the limiter itself denies the whole fleet. That is
 *      strictly worse than not limiting — it hands an attacker an amplifier. So an
 *      unidentifiable client is reported as such, never bucketed under a placeholder;
 *      the caller decides (the gate fails open, matching its error-boundary posture).
 *
 * Framework-free on purpose: this package is published and consumed for pure logic,
 * so it takes facts (a header value, a peer address) rather than a request object.
 * The hono glue lives in whichever app owns the middleware.
 */

/** The facts an adapter must supply. Both may be absent — that is the point. */
export interface ClientIdentityInput {
  /** Raw `X-Forwarded-For` value, if any. Only consulted when `trustProxy`. */
  xff: string | undefined;
  /** Socket peer address. Absent under a serverless adapter (no node socket). */
  peer: string | undefined;
  /** Is there a trusted proxy in front that appends XFF? (`TRUST_PROXY`) */
  trustProxy: boolean;
  /**
   * How many trusted hops sit in front of us, counted from the gate outward
   * (`TRUST_PROXY_HOPS`). 1 = one reverse proxy (Caddy/nginx). 2 = a CDN in front
   * of that proxy. Adding a hop is an env change, never a code change.
   */
  hops?: number;
}

export type ClientIdentity =
  | { ok: true; key: string; source: "forwarded" | "peer" }
  | { ok: false; reason: string };

/**
 * Pick the entry `hops` from the right of an XFF trail.
 *
 * Fewer entries than configured hops means the trail is shorter than we were told
 * to expect (a request that skipped a hop, or a misconfigured count) — fall back to
 * the leftmost entry rather than reading past the start. It is the best available
 * answer and never a placeholder shared by everyone.
 */
export function forwardedFor(xff: string, hops: number): string | undefined {
  const entries = xff
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  return entries[Math.max(0, entries.length - hops)];
}

/**
 * A once-only warning for "we could not identify the caller, so this budget is off".
 *
 * Lives here because both surfaces that meter by client (the gate's request limiter
 * and the console's failed-sign-in budget) make the same call — fail open, say so
 * once — and two copies of that decision is how they drift apart. Once-only matters:
 * an unidentifiable caller is usually EVERY caller, so per-request logging would bury
 * the box in the same line.
 *
 * @param what the budget that is off, named for the operator ("rate limit", …)
 */
export function createUnidentifiedWarner(what: string): (reason: string) => void {
  let warned = false;
  return (reason: string) => {
    if (warned) return;
    warned = true;
    console.warn(
      `🜉 ${what}: cannot identify callers, so it is OFF for them — ${reason}. ` +
        `Serving them anyway (fail-open) rather than metering everyone against one ` +
        `shared bucket, which would let a single caller lock out the rest.`,
    );
  };
}

/** Resolve the bucket key for a request, or say why it can't be resolved. */
export function resolveClientIdentity({
  xff,
  peer,
  trustProxy,
  hops = 1,
}: ClientIdentityInput): ClientIdentity {
  if (trustProxy && xff) {
    const forwarded = forwardedFor(xff, Math.max(1, hops));
    if (forwarded) return { ok: true, key: forwarded, source: "forwarded" };
  }
  if (peer) return { ok: true, key: peer, source: "peer" };
  return {
    ok: false,
    reason: trustProxy
      ? "no socket peer and no X-Forwarded-For — nothing identifies the caller"
      : "no socket peer, and X-Forwarded-For is not trusted (set TRUST_PROXY=true " +
        "if a reverse proxy or serverless platform sits in front and sets it)",
  };
}
