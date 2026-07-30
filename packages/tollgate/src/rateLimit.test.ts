/**
 * The gate's rate-limit middleware — the glue, not the state machine.
 *
 * `rateLimitCore` and `clientIdentity` are unit-tested in `@naulon/shared`. What was
 * never tested is this file: the middleware mounted globally on every gate request,
 * which reads the header, asks for the socket peer, and shapes the 429. That is the
 * code that was wrong in production — buckets keyed to one shared value because
 * `TRUST_PROXY` was unset behind a reverse proxy — so it is the code that needs a test
 * of its own.
 *
 * Two halves, deliberately:
 *   - `app.request()` has no socket, so `getConnInfo` throws and the ONLY identity
 *     available is the header. That is the serverless shape.
 *   - one test boots a real `@hono/node-server` listener, because the socket-peer path
 *     runs through `getConnInfo` and no in-process request can reach it. That is the
 *     shape prod actually runs.
 *
 * Env is set before the import: `rateLimit.ts` reads config at module scope.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-ratelimit-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";

const { rateLimit } = await import("./rateLimit.ts");

function appWith(opts: Parameters<typeof rateLimit>[0]) {
  const app = new Hono();
  app.use("*", rateLimit(opts));
  app.get("*", (c) => c.text("served"));
  return app;
}

/** `app.request` carries no socket, so XFF + trustProxy is how a test gets an identity. */
const xff = (value: string) => ({ headers: { "x-forwarded-for": value } });

test("rpm 0 disables the limiter entirely", async () => {
  const app = appWith({ rpm: 0, burst: 1, trustProxy: true });
  for (let i = 0; i < 50; i++) {
    assert.equal((await app.request("/", xff("203.0.113.1"))).status, 200);
  }
});

test("the bucket is keyed to the entry our own proxy appended, not the caller's claim", async () => {
  // One real client behind one trusted proxy. It rotates the left entry every request
  // — the pre-fix code handed each forgery a fresh bucket, so the flood was free.
  const app = appWith({ rpm: 60, burst: 3, trustProxy: true, hops: 1 });
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/", xff(`10.0.0.${i}, 198.51.100.7`));
    codes.push(res.status);
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429], "rotating the forged entry must not buy a new bucket");
});

test("two different real clients behind the proxy do not share a bucket", async () => {
  const app = appWith({ rpm: 60, burst: 2, trustProxy: true, hops: 1 });
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.request("/", xff("10.0.0.1, 198.51.100.7"))).status, 200);
  }
  assert.equal((await app.request("/", xff("10.0.0.1, 198.51.100.7"))).status, 429, "first client spent its burst");
  assert.equal(
    (await app.request("/", xff("10.0.0.1, 198.51.100.8"))).status,
    200,
    "a second client must not inherit the first one's exhausted bucket",
  );
});

test("hops counts from the right, so a CDN in front of the proxy is read correctly", async () => {
  // client → CDN → proxy → gate. The CDN appended the client, the proxy appended the
  // CDN: with two trusted hops the client is the second entry from the right.
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true, hops: 2 });
  assert.equal((await app.request("/", xff("forged, 203.0.113.5, 198.51.100.7"))).status, 200);
  assert.equal(
    (await app.request("/", xff("other, 203.0.113.5, 198.51.100.7"))).status,
    429,
    "same real client, different forgery — one bucket",
  );
  assert.equal(
    (await app.request("/", xff("forged, 203.0.113.6, 198.51.100.7"))).status,
    200,
    "a different real client is a different bucket",
  );
});

test("a caller with no socket is metered on the forwarded header, TRUST_PROXY or not", async () => {
  // The serverless shape. TRUST_PROXY defaults to false, so requiring it left the
  // limiter switched off on exactly the deployments facing the open internet. An absent
  // socket peer is itself evidence of an adapter in front, so the header is used.
  const app = appWith({ rpm: 60, burst: 2, trustProxy: false });
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await app.request("/", xff("203.0.113.1"))).status);
  assert.deepEqual(codes, [200, 200, 429]);
  assert.equal(
    (await app.request("/", xff("203.0.113.2"))).status,
    200,
    "and it is still per client, not one bucket for everyone",
  );
});

test("with nothing at all to identify a caller, the limiter fails open", async () => {
  // No socket under app.request and no header either. It must FAIL OPEN rather than
  // collapse everyone into one shared bucket: sharing lets a single caller 429 the whole
  // fleet, which is worse than not limiting. (The console's failed-sign-in budget makes
  // the opposite call, because it charges only rejections — see authThrottle.ts.)
  const app = appWith({ rpm: 60, burst: 1, trustProxy: false });
  for (let i = 0; i < 30; i++) {
    assert.equal(
      (await app.request("/")).status,
      200,
      "an unidentifiable caller is served, not metered against a placeholder key",
    );
  }
});

test("a refusal is a 429 with a retry-after a client can act on", async () => {
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true });
  assert.equal((await app.request("/", xff("198.51.100.20"))).status, 200);
  const res = await app.request("/", xff("198.51.100.20"));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: "rate limit exceeded" });
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter >= 1, `retry-after must be a usable delay, got ${res.headers.get("retry-after")}`);
});

test("a bucket refills, so a 429 is not a permanent ban", async () => {
  let clock = 1_000_000;
  const app = appWith({ rpm: 60, burst: 1, trustProxy: true, now: () => clock });
  assert.equal((await app.request("/", xff("198.51.100.30"))).status, 200);
  assert.equal((await app.request("/", xff("198.51.100.30"))).status, 429);
  clock += 1_100; // 60/min = one token per second
  assert.equal((await app.request("/", xff("198.51.100.30"))).status, 200, "the bucket must refill on the clock");
});

test("the socket peer identifies a caller when no proxy is trusted (the real-server path)", async () => {
  // The one path no in-process request can reach: getConnInfo needs a node socket.
  // This is what prod runs when TRUST_PROXY is unset.
  const app = appWith({ rpm: 60, burst: 2, trustProxy: false });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: s, port: info.port }),
    );
  });
  try {
    const url = `http://127.0.0.1:${port}/`;
    const codes = [
      (await fetch(url)).status,
      (await fetch(url)).status,
      (await fetch(url)).status,
    ];
    assert.deepEqual(codes, [200, 200, 429], "the socket peer must be a usable bucket key");
  } finally {
    server.close();
  }
});
