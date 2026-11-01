import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { sharedKeyAuth } from "./sharedKeyAuth.ts";

const KEY = "k".repeat(40);
const resolver = { async resolve(host: string) { return host === "known.example" ? ({ id: "pub_known" } as never) : undefined; } };

async function run(authorization: string | undefined, host: string | null) {
  const app = new Hono();
  let result: unknown;
  app.get("/", async (c) => { result = await sharedKeyAuth(KEY, resolver)(c, host); return c.text("ok"); });
  await app.request("/", authorization ? { headers: { authorization } } : {});
  return result as { ok: boolean; status?: number; publisherId?: string; selfHosted?: boolean };
}

test("the right key for a host the resolver knows is that host's publisher, self-hosted", async () => {
  assert.deepEqual(await run(`Bearer ${KEY}`, "known.example"), { ok: true, publisherId: "pub_known", selfHosted: true });
});

test("sharedKeyAuth refuses a host the resolver does not know", async () => {
  const r = await run(`Bearer ${KEY}`, "other.example");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("a missing, malformed or wrong key is 401", async () => {
  for (const h of [undefined, KEY, `Bearer ${KEY}x`, `Bearer ${"k".repeat(39)}`, "Basic abc"]) {
    const r = await run(h, "known.example");
    assert.equal(r.status, 401, String(h));
  }
});

test("a valid key with no host still authenticates, for routes that name none", async () => {
  const r = await run(`Bearer ${KEY}`, null);
  assert.equal(r.ok, true);
});

test("an unauthenticated caller never reaches the resolver", async () => {
  let asked = 0;
  const app = new Hono();
  app.get("/", async (c) => {
    await sharedKeyAuth(KEY, { async resolve() { asked++; return undefined; } })(c, "known.example");
    return c.text("ok");
  });
  await app.request("/");
  assert.equal(asked, 0);
});

test("a key shorter than 32 characters is refused at construction", () => {
  assert.throws(() => sharedKeyAuth("short", resolver), /32/);
});

const SITE_KEY = "s".repeat(40);
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const perSite = {
  async resolve(host: string) {
    if (host === "a.example") return { id: "pub_a", enforceKeySha256: sha(SITE_KEY) } as never;
    if (host === "b.example") return { id: "pub_b", enforceKeySha256: sha("t".repeat(40)) } as never;
    if (host === "c.example") return { id: "pub_c" } as never;
    return undefined;
  },
};

async function runWith(r: typeof perSite, authorization: string, host: string | null) {
  const app = new Hono();
  let result: unknown;
  app.get("/", async (c) => { result = await sharedKeyAuth(KEY, r)(c, host); return c.text("ok"); });
  await app.request("/", { headers: { authorization } });
  return result as { ok: boolean; status?: number; publisherId?: string };
}

test("a site's own key authorizes its own host", async () => {
  assert.deepEqual(await runWith(perSite, `Bearer ${SITE_KEY}`, "a.example"), { ok: true, publisherId: "pub_a", selfHosted: true });
});

test("a site's own key never authorizes another site's host", async () => {
  assert.equal((await runWith(perSite, `Bearer ${SITE_KEY}`, "b.example")).status, 401);
  assert.equal((await runWith(perSite, `Bearer ${SITE_KEY}`, "c.example")).status, 401);
});

test("a site key cannot pass a host-less check, which only the operator key answers", async () => {
  assert.equal((await runWith(perSite, `Bearer ${SITE_KEY}`, null)).status, 401);
});

test("the operator key still authorizes every host the resolver knows", async () => {
  for (const h of ["a.example", "b.example", "c.example"]) assert.equal((await runWith(perSite, `Bearer ${KEY}`, h)).ok, true, h);
});
