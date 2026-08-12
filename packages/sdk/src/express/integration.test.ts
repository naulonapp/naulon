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
import { createExpressWebhookReceiver } from "./webhook-receiver.ts";
import { memoryIdempotencyStore } from "../idempotency.ts";
import { signPayload } from "../crypto/webhook.ts";
import type { ArticleCredits } from "../contract/index.ts";

const SECRET = "whsec_integration";
const CREDITS = {
  slug: "on-stillness", title: "On Stillness",
  contributors: [{ authorId: "ava", wallet: "0x1111111111111111111111111111111111111111" }],
} as unknown as ArticleCredits;

/** A signed delivery, exactly as the sender writes it on the wire. */
function delivery(over: Record<string, unknown> = {}) {
  const rawBody = JSON.stringify({
    id: "dlv_1",
    type: "settlement.completed",
    eventId: "evt_1",
    createdAt: 1_700_000_000_000,
    data: { tenant: "acme", announced: 1 },
    ...over,
  });
  const t = Math.floor(Date.now() / 1000);
  return { rawBody, headers: { "naulon-signature": signPayload(SECRET, rawBody, t) } };
}

/** Stand up a real express app with both adapters; return its base URL + a teardown. */
async function serve() {
  const seen: string[] = [];
  const app = express();
  app.get("/api/credits/:slug", createExpressCreditsRoute({
    resolve: async (slug: string) => (slug === "on-stillness" ? CREDITS : undefined),
  }));
  app.post(
    "/naulon-hook",
    express.raw({ type: "*/*" }),
    createExpressWebhookReceiver({ secrets: [SECRET], idempotency: memoryIdempotencyStore(), onEvent: async (e) => { seen.push(e.eventId); } }),
  );
  // The footgun: express.json() parses + discards the raw bytes → adapter must fail loud.
  app.post(
    "/bad/naulon-hook",
    express.json(),
    createExpressWebhookReceiver({ secrets: [SECRET], idempotency: memoryIdempotencyStore(), onEvent: async () => {} }),
  );
  const server = await new Promise<import("node:http").Server>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("real express: valid delivery → 200 + onEvent once; redelivery → deduped; tamper → 401", async () => {
  const { base, seen, close } = await serve();
  try {
    const fx = delivery();
    const r1 = await fetch(`${base}/naulon-hook`, { method: "POST", headers: fx.headers, body: fx.rawBody });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, deduped: false });
    assert.equal(seen.length, 1);

    const r2 = await fetch(`${base}/naulon-hook`, { method: "POST", headers: fx.headers, body: fx.rawBody });
    assert.deepEqual(await r2.json(), { ok: true, deduped: true });
    assert.equal(seen.length, 1, "a redelivery must not run the handler twice");

    const r3 = await fetch(`${base}/naulon-hook`, { method: "POST", headers: fx.headers, body: fx.rawBody + " " });
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
    const fx = delivery();
    const res = await fetch(`${base}/bad/naulon-hook`, { method: "POST", headers: { ...fx.headers, "content-type": "application/json" }, body: fx.rawBody });
    assert.equal(res.status, 500, "express.json() discards the raw bytes → the adapter throws, surfaced as 500");
  } finally { await close(); }
});
