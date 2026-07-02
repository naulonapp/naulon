/**
 * Per-client rate limiting — a DoS backstop for the gate.
 *
 * The tollgate does real work per request (classify, resolve credits, verify a
 * payment), so an unthrottled flood is a cheap way to exhaust it. A token bucket
 * per client smooths that: each client refills at RATE_LIMIT_RPM/min and may
 * burst up to RATE_LIMIT_BURST before getting a 429.
 *
 * Client identity is the socket peer IP by default. X-Forwarded-For is trusted
 * ONLY when TRUST_PROXY=true — otherwise any client spoofs the header and gets
 * its own private bucket, defeating the limit.
 *
 * In-memory + single-process. Behind multiple instances, either pin clients to
 * an instance or move the buckets to a shared store.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getConfig } from "@naulon/shared";

const cfg = getConfig();

interface Bucket {
  tokens: number;
  last: number; // epoch ms of last refill
}

const buckets = new Map<string, Bucket>();
const refillPerMs = cfg.RATE_LIMIT_RPM / 60_000;
const capacity = cfg.RATE_LIMIT_BURST;

function clientKey(c: Context): string {
  if (cfg.TRUST_PROXY) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim(); // leftmost = original client
  }
  // getConnInfo needs a node socket; it throws under a serverless adapter
  // (Vercel) or app.request(). Degrade to a shared bucket rather than 500.
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Take one token; returns remaining-seconds-to-wait if the bucket is empty. */
function take(key: string, now: number): { allowed: boolean; retryAfter: number } {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, last: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
}

// Periodic prune so idle clients don't accumulate. Bucket is stale once it would
// have fully refilled.
function sweep(now: number): void {
  const fullRefillMs = capacity / refillPerMs;
  for (const [k, b] of buckets) {
    if (now - b.last > fullRefillMs) buckets.delete(k);
  }
}
let lastSweep = 0;

/** Hono middleware. No-op when RATE_LIMIT_RPM=0. */
export function rateLimit(): MiddlewareHandler {
  if (cfg.RATE_LIMIT_RPM === 0) {
    return async (_c, next) => next();
  }
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      sweep(now);
      lastSweep = now;
    }
    const { allowed, retryAfter } = take(clientKey(c), now);
    if (!allowed) {
      return c.json({ error: "rate limit exceeded" }, 429, {
        "Retry-After": String(Math.max(1, retryAfter)),
      });
    }
    return next();
  };
}
