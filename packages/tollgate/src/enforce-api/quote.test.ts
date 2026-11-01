import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { build402 } from "@naulon/enforce";
import { mountEnforceApi, type EnforceApiDeps } from "./index.ts";

const publisherOf = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, articlePrefixes: ["essays"], licenseIdentity: "did:web:t", ...over }) as never;
const aQuote = {
  slug: "essays/x", kind: "read", title: "X", price: 5000,
  payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }], extraLegs: [], coauthorSplit: false,
};
const KEY = "Bearer good-key";

function appWith(opts: {
  resolveHost?: (host: string) => unknown;
  priced?: unknown;
  price?: (...a: unknown[]) => Promise<unknown>;
  hooks?: EnforceApiDeps["hooks"];
  build402?: unknown;
} = {}) {
  const app = new OpenAPIHono();
  mountEnforceApi(app, {
    resolver: { resolve: async (host: string) => (opts.resolveHost ? opts.resolveHost(host) : publisherOf("pub_a")) } as never,
    auth: async (c) => (c.req.header("authorization") === KEY ? { ok: true, publisherId: "pub_a", selfHosted: true } : { ok: false, status: 401, error: "unauthorized" }),
    observe: () => {},
    now: () => 1_700_000_000_000,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    impl: {
      price: (opts.price ?? (async () => ("priced" in opts ? opts.priced : aQuote))) as never,
      ...(opts.build402 ? { build402: opts.build402 as never } : {}),
    },
  });
  return app;
}

const headers = { authorization: KEY };
const RESOURCE = "http://h.test/essays/x";
const q = (extra = "") => `/_naulon/quote?resource=${encodeURIComponent(RESOURCE)}&slug=essays/x&kind=read${extra}`;

test("missing key is 401", async () => {
  assert.equal((await appWith().request("/_naulon/quote?resource=http://h/x&slug=x")).status, 401);
});

test("missing slug is 400", async () => {
  const res = await appWith().request(`/_naulon/quote?resource=${encodeURIComponent(RESOURCE)}`, { headers });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad request" });
});

test("an unparseable resource is 400 bad resource", async () => {
  const res = await appWith().request("/_naulon/quote?resource=not-a-url&slug=x", { headers });
  assert.deepEqual(await res.json(), { error: "bad resource" });
});

test("a resource resolving to another publisher is 403", async () => {
  assert.equal((await appWith({ resolveHost: () => publisherOf("pub_b") }).request(q(), { headers })).status, 403);
});

test("a tollable resource is 200 with the custody-free quote", async () => {
  const res = await appWith().request(q(), { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), aQuote);
});

test("an untollable resource is 204", async () => {
  assert.equal((await appWith({ priced: undefined }).request(q(), { headers })).status, 204);
});

test("the stamp fires for an owned host, on a 204 too, and never on a refusal", async () => {
  const calls: string[] = [];
  const hooks = { stampInApp: (id: string, host: string) => void calls.push(`${id}@${host}`) };
  await appWith({ hooks }).request(q(), { headers });
  await appWith({ hooks, priced: undefined }).request(q(), { headers });
  await appWith({ hooks }).request(q());
  await appWith({ hooks, resolveHost: () => publisherOf("pub_b") }).request(q(), { headers });
  assert.deepEqual(calls, ["pub_a@h.test", "pub_a@h.test"]);
});

test("build=402 hands the gate's own builder the quote, resource and clock, and returns its legs", async () => {
  const calls: unknown[][] = [];
  const spy = (...a: unknown[]) => { calls.push(a); return { header: "HDR", legs: [{ payTo: "x", amount: "1" }] }; };
  const res = await appWith({ build402: spy }).request(q("&build=402"), { headers });
  assert.deepEqual(calls, [[aQuote, RESOURCE, 1_700_000_000_000]]);
  assert.deepEqual(((await res.json()) as { x402: unknown }).x402, { header: "HDR", legs: [{ payTo: "x", amount: "1" }] });
});

test("build=402 without an injected builder produces a real x402 header", async () => {
  const body = (await (await appWith().request(q("&build=402"), { headers })).json()) as { x402: { header: string } };
  const decoded = JSON.parse(Buffer.from(body.x402.header, "base64").toString("utf8")) as { x402Version: number; accepts: { scheme: string }[] };
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepts[0]?.scheme, "exact");
});

test("without build=402 there is no x402 key", async () => {
  const body = (await (await appWith().request(q(), { headers })).json()) as Record<string, unknown>;
  assert.ok(!("x402" in body));
});

test("a free resource is still 204 with build=402", async () => {
  assert.equal((await appWith({ priced: undefined }).request(q("&build=402"), { headers })).status, 204);
});

test("terms that give agent reads away answer 204 before any price lookup", async () => {
  let priced = 0;
  const app = appWith({
    resolveHost: () => publisherOf("pub_a", { termsPolicy: { "ai-input": "free" } }),
    price: async () => { priced++; return aQuote; },
  });
  assert.equal((await app.request(q(), { headers })).status, 204);
  assert.equal(priced, 0);
});

test("a verified agent reaches the price lookup lowercased; a malformed one is dropped", async () => {
  const seen: unknown[] = [];
  const app = appWith({ price: async (...a) => { seen.push(a[4]); return aQuote; } });
  await app.request(q("&verifiedAgent=ChatGPT.com"), { headers });
  await app.request(q("&verifiedAgent=not%20a%20host!"), { headers });
  assert.deepEqual(seen, ["chatgpt.com", undefined]);
});

test("the price lookup gets the pathname alone, never the query string", async () => {
  const seen: unknown[] = [];
  const app = appWith({ price: async (...a) => { seen.push(a[3]); return aQuote; } });
  await app.request(`/_naulon/quote?resource=${encodeURIComponent("http://h.test/essays/x?utm=1")}&slug=essays/x`, { headers });
  assert.deepEqual(seen, ["/essays/x"]);
});

test("a quote with nobody to pay reaches only a runtime that says it can observe", async () => {
  const nobody = { ...aQuote, payees: [] };
  assert.equal((await appWith({ priced: nobody }).request(q(), { headers })).status, 204);
  const res = await appWith({ priced: nobody }).request(q("&observe=1&build=402"), { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { x402: unknown }).x402, { header: "", legs: [] });
});
