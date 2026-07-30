/**
 * Token-bucket rate limiting — the state machine, with no web framework in it.
 *
 * Extracted here because two surfaces need the same limiter and a second copy of a
 * limiter is a second set of off-by-ones: the gate (which does real work per request
 * — classify, resolve credits, verify a payment) and the operator console (whose
 * HTTP Basic credential is otherwise brute-forceable at wire speed once it is bound
 * anywhere but loopback).
 *
 * Each client refills at `rpm`/minute and may burst to `burst` before a 429.
 * `now` is injected so tests drive time instead of sleeping.
 */

export interface RateLimitOptions {
  /** Sustained requests per minute per client. 0 disables (see `enabled`). */
  rpm: number;
  /** Burst capacity — how many requests a fresh client may spend at once. */
  burst: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /**
   * Hard ceiling on live buckets. See `MAX_BUCKETS` — this exists because keying per
   * client makes the key space as large as the caller's address space.
   */
  maxBuckets?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds to wait before a retry would succeed. 0 when allowed. */
  retryAfter: number;
}

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill. */
  last: number;
}

export interface RateLimiter {
  /** Spend one token for `key`. */
  take(key: string): RateLimitVerdict;
  /**
   * Would `take` succeed? Spends nothing and mutates nothing.
   *
   * For budgets that should only be charged for a specific OUTCOME — failed
   * sign-ins, say — where checking up front and charging after the fact are two
   * separate moments and a successful request must cost nothing.
   */
  peek(key: string): RateLimitVerdict;
  /** Is limiting on at all? False when rpm is 0. */
  readonly enabled: boolean;
  /** Live bucket count — for tests and diagnostics. */
  size(): number;
}

/** Sweep interval: buckets are only pruned this often, not on every request. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Ceiling on live buckets.
 *
 * Keying per client is what makes the limiter fair, and it is also what makes the key
 * space unbounded: one entry per distinct address, and an address is cheap. A host with
 * a routed IPv6 /64 can emit a different source address per request, so a flood creates
 * a bucket per request instead of contending for one. The periodic sweep only drops
 * buckets that have fully refilled, so between sweeps the map grows with the flood — and
 * the sweep itself walks every entry, so a map allowed to reach millions turns into a
 * stall on the interval.
 *
 * Worth being explicit that this ceiling is the reason the previous shape never showed
 * the problem: when every caller collapsed into one key (the bug this limiter's identity
 * rule fixes) there was exactly one bucket to hold. Fixing the key had to come with a
 * bound on the keys.
 *
 * Over the ceiling, the oldest entry is evicted. Insertion order is what a Map already
 * maintains, so eviction is O(1) and needs no second index; the cost is that an evicted
 * client starts fresh, which is the same answer they would get from a sweep a moment
 * later. Bounded memory under a flood beats exact accounting during one.
 */
const MAX_BUCKETS = 50_000;

export function createRateLimiter({
  rpm,
  burst,
  now = Date.now,
  maxBuckets = MAX_BUCKETS,
}: RateLimitOptions): RateLimiter {
  const enabled = rpm > 0;
  const refillPerMs = rpm / 60_000;
  const capacity = burst;
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  /**
   * Drop buckets that have fully refilled — a full bucket is indistinguishable from
   * a client we have never seen, so keeping it says nothing and costs memory.
   */
  const sweep = (t: number): void => {
    const fullRefillMs = capacity / refillPerMs;
    for (const [k, b] of buckets) {
      if (t - b.last > fullRefillMs) buckets.delete(k);
    }
  };

  /** Tokens `key` would have right now, without writing anything back. */
  const tokensAt = (b: Bucket, t: number): number =>
    Math.min(capacity, b.tokens + (t - b.last) * refillPerMs);

  return {
    enabled,
    size: () => buckets.size,
    peek(key: string): RateLimitVerdict {
      if (!enabled) return { allowed: true, retryAfter: 0 };
      const b = buckets.get(key);
      if (!b) return { allowed: true, retryAfter: 0 };
      const tokens = tokensAt(b, now());
      if (tokens >= 1) return { allowed: true, retryAfter: 0 };
      return { allowed: false, retryAfter: Math.ceil((1 - tokens) / refillPerMs / 1000) };
    },
    take(key: string): RateLimitVerdict {
      if (!enabled) return { allowed: true, retryAfter: 0 };
      const t = now();
      if (t - lastSweep > SWEEP_EVERY_MS) {
        sweep(t);
        lastSweep = t;
      }
      let b = buckets.get(key);
      if (!b) {
        // A new key under pressure: try reclaiming refilled buckets before evicting a
        // live one, so ordinary traffic never pays the eviction cost.
        if (buckets.size >= maxBuckets) {
          sweep(t);
          while (buckets.size >= maxBuckets) {
            const oldest = buckets.keys().next().value;
            if (oldest === undefined) break;
            buckets.delete(oldest);
          }
        }
        b = { tokens: capacity, last: t };
        buckets.set(key, b);
      }
      b.tokens = tokensAt(b, t);
      b.last = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, retryAfter: 0 };
      }
      return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
    },
  };
}
