import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { authThrottle } from "./authThrottle.ts";

/**
 * A stand-in for the basicAuth that sits behind the throttle: the credential is
 * "good", anything else 401s. The throttle must only ever charge the 401s.
 */
function appWith(opts: Parameters<typeof authThrottle>[0], now?: () => number) {
  const app = new Hono();
  app.use("*", authThrottle({ ...opts, now }));
  app.get("*", (c) => {
    if (c.req.header("authorization") !== "good") return c.text("unauthorized", 401);
    return c.text("ops console");
  });
  return app;
}

/** `app.request` has no socket, so XFF + trustProxy is how a test gets an identity. */
const from = (ip: string, auth?: string) => ({
  headers: auth
    ? { "x-forwarded-for": ip, authorization: auth }
    : { "x-forwarded-for": ip },
});

test("a correct credential is never charged, however many times it is used", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/", from("203.0.113.9", "good"));
    assert.equal(res.status, 200, `request ${i} should still be served`);
  }
});

test("failed sign-ins burn the budget, then the throttle refuses with Retry-After", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);

  const throttled = await app.request("/", from("198.51.100.5"));
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("Retry-After")) >= 1);
  // The operator gets told where their own credential lives, not just "429".
  assert.match(await throttled.text(), /DASHBOARD_AUTH/);
});

test("a throttled guesser cannot lock out the real operator", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 429);
  // Different client, correct credential — unaffected.
  assert.equal((await app.request("/", from("203.0.113.9", "good"))).status, 200);
});

test("the budget refills, so a lockout is temporary", async () => {
  let t = 1_000_000;
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true }, () => t);
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 429);
  t += 1000; // 60/min = one token per second
  assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);
});

test("a forged X-Forwarded-For cannot dodge the budget", async () => {
  // Our proxy appends what it saw; the leftmost entry is the client's own claim.
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  assert.equal(
    (await app.request("/", { headers: { "x-forwarded-for": "lie-1, 198.51.100.5" } })).status,
    401,
  );
  const second = await app.request("/", {
    headers: { "x-forwarded-for": "lie-2, 198.51.100.5" },
  });
  assert.equal(second.status, 429, "rotating the forged entry must not buy a fresh budget");
});

test("rpm 0 disables the budget", async () => {
  const app = appWith({ rpm: 0, burst: 1, trustProxy: true });
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.request("/", from("198.51.100.5"))).status, 401);
  }
});

test("an unidentifiable caller fails open rather than sharing one budget", async () => {
  // No socket peer (app.request) and XFF untrusted: metering everyone together would
  // let one guesser lock out every operator.
  const app = appWith({ rpm: 60, burst: 1, trustProxy: false });
  assert.equal((await app.request("/")).status, 401);
  assert.equal((await app.request("/")).status, 401);
  assert.equal((await app.request("/", from("1.2.3.4", "good"))).status, 200);
});
