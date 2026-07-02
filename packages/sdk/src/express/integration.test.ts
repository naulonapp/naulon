/**
 * REAL express integration — the adapters driven by an actual express app over a real
 * socket (express is a devDependency for exactly this). The unit tests use structural
 * req/res doubles; this proves the bridge against express's genuine req.body Buffer (via
 * express.raw), header object, and res.status/setHeader/send — and that the express.json()
 * footgun fails loud rather than silently rejecting every signature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createExpressCreditsRoute } from "./credits-route.ts";
import { createExpressSettlementReceiver } from "./settlement-receiver.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import { makeSignedSettlementFixture } from "../crypto/fixture.ts";
import type { ArticleCredits } from "../contract/index.ts";

const SECRET = "integration-secret";
const CREDITS = {
  slug: "on-stillness", title: "On Stillness",
  contributors: [{ authorId: "ava", wallet: "0x1111111111111111111111111111111111111111" }],
} as unknown as ArticleCredits;

/** Stand up a real express app with both adapters; return its base URL + a teardown. */
async function serve() {
  const seen: string[] = [];
  const app = express();
  app.get("/api/credits/:slug", createExpressCreditsRoute({
    resolve: async (slug: string) => (slug === "on-stillness" ? CREDITS : undefined),
  }));
  app.post(
    "/api/credits/settlement",
    express.raw({ type: "*/*" }),
    createExpressSettlementReceiver({ secrets: [SECRET], idempotency: memoryIdempotencyStore(), onEvent: async (e) => { seen.push(e.eventId); } }),
  );
  // The footgun: express.json() parses + discards the raw bytes → adapter must fail loud.
  app.post(
    "/bad/settlement",
    express.json(),
    createExpressSettlementReceiver({ secrets: [SECRET], idempotency: memoryIdempotencyStore(), onEvent: async () => {} }),
  );
  const server = await new Promise<import("node:http").Server>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("real express: valid settlement → 200 + onEvent once; replay → deduped; tamper → 401", async () => {
  const { base, seen, close } = await serve();
  try {
    const fx = makeSignedSettlementFixture({ secret: SECRET });
    const r1 = await fetch(`${base}/api/credits/settlement`, { method: "POST", headers: fx.headers, body: fx.rawBody });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, deduped: false });
    assert.equal(seen.length, 1);

    const r2 = await fetch(`${base}/api/credits/settlement`, { method: "POST", headers: fx.headers, body: fx.rawBody });
    assert.deepEqual(await r2.json(), { ok: true, deduped: true });
    assert.equal(seen.length, 1, "replay must not re-pay");

    const r3 = await fetch(`${base}/api/credits/settlement`, { method: "POST", headers: fx.headers, body: fx.rawBody + " " });
    assert.equal(r3.status, 401, "tampered raw bytes must fail the HMAC");
  } finally { await close(); }
});

test("real express: credits 200 for a known slug, 404 (free) for an unknown one", async () => {
  const { base, close } = await serve();
  try {
    const ok = await fetch(`${base}/api/credits/on-stillness`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { slug: string }).slug, "on-stillness");
    const free = await fetch(`${base}/api/credits/nope`);
    assert.equal(free.status, 404);
    assert.deepEqual(await free.json(), { error: "not_found" });
  } finally { await close(); }
});

test("real express: mounting the receiver behind express.json() fails loud (not a silent 401)", async () => {
  const { base, close } = await serve();
  try {
    const fx = makeSignedSettlementFixture({ secret: SECRET });
    const res = await fetch(`${base}/bad/settlement`, { method: "POST", headers: { ...fx.headers, "content-type": "application/json" }, body: fx.rawBody });
    assert.equal(res.status, 500, "express.json() discards the raw bytes → the adapter throws, surfaced as 500");
  } finally { await close(); }
});
