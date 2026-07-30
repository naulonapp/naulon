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

/** A guess: a credential was presented and rejected. Only these are charged. */
const guess = (ip: string) => from(ip, "wrong");

test("a correct credential is never charged, however many times it is used", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  for (let i = 0; i < 20; i++) {
    const res = await app.request("/", from("203.0.113.9", "good"));
    assert.equal(res.status, 200, `request ${i} should still be served`);
  }
});

test("failed sign-ins burn the budget, then the throttle refuses with Retry-After", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);

  const throttled = await app.request("/", guess("198.51.100.5"));
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("Retry-After")) >= 1);
  // The operator gets told where their own credential lives, not just "429".
  assert.match(await throttled.text(), /DASHBOARD_AUTH/);
});

test("a throttled guesser cannot lock out the real operator", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 429);
  // Different client, correct credential — unaffected.
  assert.equal((await app.request("/", from("203.0.113.9", "good"))).status, 200);
});

test("the budget refills, so a lockout is temporary", async () => {
  let t = 1_000_000;
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true }, () => t);
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 429);
  t += 1000; // 60/min = one token per second
  assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);
});

test("a forged X-Forwarded-For cannot dodge the budget", async () => {
  // Our proxy appends what it saw; the leftmost entry is the client's own claim.
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  assert.equal(
    (await app.request("/", { headers: { "x-forwarded-for": "lie-1, 198.51.100.5", authorization: "wrong" } })).status,
    401,
  );
  const second = await app.request("/", {
    headers: { "x-forwarded-for": "lie-2, 198.51.100.5", authorization: "wrong" },
  });
  assert.equal(second.status, 429, "rotating the forged entry must not buy a fresh budget");
});

test("rpm 0 disables the budget", async () => {
  const app = appWith({ rpm: 0, burst: 1, trustProxy: true });
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.request("/", guess("198.51.100.5"))).status, 401);
  }
});

test("a shared budget still lets the real operator in — only failures are charged", async () => {
  // No socket peer (app.request) and XFF untrusted, so every caller lands in the one
  // shared bucket. Spending it must not cost the operator their own console: the
  // correct credential is never charged, so it is still served after the guesses.
  const app = appWith({ rpm: 60, burst: 1, trustProxy: false });
  const anon = { headers: { authorization: "wrong" } };
  assert.equal((await app.request("/", anon)).status, 401);
  assert.equal((await app.request("/", anon)).status, 429, "the shared budget is spent");
  assert.equal(
    (await app.request("/", from("1.2.3.4", "good"))).status,
    200,
    "an identified caller has its own budget and is unaffected",
  );
});

// ── An unidentifiable caller gets a shared budget, never no budget ───────────────
// This is where the console deliberately parts from the gate's limiter. The gate
// fails open because its budget is charged on every request, so one shared bucket
// would let a single caller deny every reader. This budget charges only 401s, so a
// legitimate operator is never charged and that argument does not apply — failing
// open here just removes the lockout from the serverless deployments that need it,
// since they have no socket peer and TRUST_PROXY is unset by default.

test("guessing is still metered when the caller cannot be identified", async () => {
  // No trusted proxy and no socket under app.request: identity is unavailable.
  const app = appWith({ rpm: 60, burst: 3, trustProxy: false });
  const bad = { headers: { authorization: "wrong" } };
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.request("/", bad)).status, 401, "the budget allows the first tries");
  }
  const res = await app.request("/", bad);
  assert.equal(res.status, 429, "an unidentifiable guesser must not get unlimited attempts");
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
});

test("the shared-budget refusal names the cause and the fix", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: false });
  const bad = { headers: { authorization: "wrong" } };
  await app.request("/", bad);
  const body = await (await app.request("/", bad)).text();
  assert.match(body, /cannot tell\ncallers apart/, "say why the budget is shared");
  assert.match(body, /TRUST_PROXY=true/, "name the one-line fix out of it");
});

test("a correct credential is still free when the budget is shared", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: false });
  for (let i = 0; i < 20; i++) {
    assert.equal((await app.request("/", { headers: { authorization: "good" } })).status, 200);
  }
  assert.equal(
    (await app.request("/", { headers: { authorization: "wrong" } })).status,
    401,
    "legitimate use must not have spent the shared budget",
  );
});

test("an identified caller is metered on its own address, not the shared bucket", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  const guess = (ip: string) => app.request("/", { headers: { "x-forwarded-for": ip, authorization: "wrong" } });
  assert.equal((await guess("203.0.113.40")).status, 401);
  assert.equal((await guess("203.0.113.40")).status, 429, "that address spent its budget");
  assert.equal((await guess("203.0.113.41")).status, 401, "a different address is unaffected");
});

// ── A 401 is not a failed sign-in ────────────────────────────────────────────────
// Basic auth begins with one: a browser has nothing to send until the challenge
// arrives, so every legitimate sign-in opens with a rejection. Charging those turned
// the budget on the operator — see the live walk in the report.

test("an unauthenticated request is not charged, however many arrive", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  for (let i = 0; i < 20; i++) {
    assert.equal(
      (await app.request("/", from("198.51.100.77"))).status,
      401,
      "the Basic challenge must stay reachable — it is not a guess",
    );
  }
  assert.equal(
    (await app.request("/", from("198.51.100.77", "good"))).status,
    200,
    "and the credential still gets through afterwards",
  );
});

test("the mix a first sign-in really makes: challenges, then the right credential", async () => {
  // A page, its favicon and a probe all 401 before the operator has typed anything.
  // With the default burst of 10 that used to be enough to lock the console.
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true });
  for (const path of ["/", "/favicon.svg", "/api/ops"]) {
    assert.equal((await app.request(path, from("203.0.113.50"))).status, 401);
  }
  assert.equal((await app.request("/", from("203.0.113.50", "good"))).status, 200);
});

test("a guesser is still stopped in the same number of tries", async () => {
  const app = appWith({ rpm: 60, burst: 3, trustProxy: true });
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await app.request("/", guess("198.51.100.90"))).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});
