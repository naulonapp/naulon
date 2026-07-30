import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimiter } from "./rateLimitCore.ts";

/** A clock the test drives, so nothing sleeps. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("rpm 0 disables limiting entirely", () => {
  const l = createRateLimiter({ rpm: 0, burst: 5 });
  assert.equal(l.enabled, false);
  for (let i = 0; i < 100; i++) assert.equal(l.take("a").allowed, true);
});

test("a fresh client may spend its whole burst, then is refused", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 3, now: c.now });
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, true);
  const denied = l.take("a");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1, "a refusal must say how long to wait");
});

test("buckets are per client — one exhausted client never blocks another", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 1, now: c.now });
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, false);
  assert.equal(l.take("b").allowed, true, "b must be unaffected by a");
});

test("tokens refill over time", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 1, now: c.now }); // 1/sec
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, false);
  c.advance(1000);
  assert.equal(l.take("a").allowed, true);
});

test("refill is capped at the burst size", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 2, now: c.now });
  c.advance(60 * 60 * 1000); // an hour of idling must not bank an hour of tokens
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.take("a").allowed, false);
});

test("peek reports the verdict without spending anything", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 1, now: c.now });
  assert.equal(l.peek("a").allowed, true);
  assert.equal(l.peek("a").allowed, true, "peek must not consume");
  assert.equal(l.take("a").allowed, true);
  assert.equal(l.peek("a").allowed, false);
  assert.ok(l.peek("a").retryAfter >= 1);
});

test("peek on an unknown client is allowed and creates no bucket", () => {
  const l = createRateLimiter({ rpm: 60, burst: 1 });
  assert.equal(l.peek("never-seen").allowed, true);
  assert.equal(l.size(), 0, "peeking must not allocate");
});

test("idle buckets are swept, active ones are not", () => {
  const c = clock();
  const l = createRateLimiter({ rpm: 60, burst: 1, now: c.now });
  l.take("idle");
  assert.equal(l.size(), 1);
  // Past a full refill AND past the sweep interval, the next take prunes.
  c.advance(120_000);
  l.take("active");
  assert.equal(l.size(), 1, "the fully-refilled bucket is gone; the new one remains");
  assert.equal(l.peek("active").allowed, false, "the surviving bucket is the active one");
});
