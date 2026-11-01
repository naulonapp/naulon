import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { fleetAgentHost, mountEnforceApi, type EnforceApiDeps, type EnforceAuth } from "./index.ts";

/**
 * A resolved publisher carrying fields that must never reach a runtime (`originAuthSecret`, a
 * credentials token), so the tests prove the projection DROPS them.
 */
const publisherOf = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    originUrl: "https://h.test",
    articlePrefixes: ["essays"],
    licenseIdentity: "naulon:h.test",
    price: 0.001,
    citationMultiplier: 3,
    credits: { resolve: async () => undefined },
    seoAllowlist: ["googlebot", "bingbot"],
    crawlerPolicy: { allow: ["googlebot"], block: ["badbot"], charge: ["oai-searchbot"] },
    gateScope: { mode: "site", excludePrefixes: ["api"] },
    termsPolicy: { "ai-input": "priced", "ai-train": "prohibit" },
    originAuthSecret: "secret-a",
    creditsApiToken: "secret-b",
    ...over,
  }) as never;

const KEY = "Bearer good-key";
const keyAuth = (publisherId = "pub_a"): EnforceAuth => async (c) =>
  c.req.header("authorization") === KEY
    ? { ok: true, publisherId, selfHosted: true }
    : { ok: false, status: 401, error: "unauthorized" };

function appWith(over: Partial<EnforceApiDeps> & { resolveHost?: (host: string) => unknown } = {}) {
  const app = new OpenAPIHono();
  const { resolveHost, ...rest } = over;
  mountEnforceApi(app, {
    resolver: { resolve: async (host: string) => (resolveHost ? resolveHost(host) : publisherOf("pub_a")) } as never,
    auth: keyAuth(),
    observe: () => {},
    ...rest,
  });
  return app;
}

const keyHeaders = { authorization: KEY };
const url = (resource = "https://h.test/essays/x") => `/_naulon/enforce-config?resource=${encodeURIComponent(resource)}`;

test("config refuses an unauthenticated read before resolving", async () => {
  let resolved = 0;
  const app = appWith({ resolveHost: () => { resolved++; return publisherOf("pub_a"); } });
  const res = await app.request(url());
  assert.equal(res.status, 401);
  assert.equal(resolved, 0, "the resolver must not be asked about a host for an unauthenticated caller");
});

test("missing resource is a 400, after auth", async () => {
  assert.equal((await appWith().request("/_naulon/enforce-config")).status, 401);
  assert.equal((await appWith().request("/_naulon/enforce-config", { headers: keyHeaders })).status, 400);
});

test("a host owned by another publisher is a 403 and leaks nothing", async () => {
  const res = await appWith({ resolveHost: () => publisherOf("pub_b") }).request(url(), { headers: keyHeaders });
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.ok(!body.includes("essays") && !body.includes("pub_b"));
});

test("an unknown host is a 403", async () => {
  assert.equal((await appWith({ resolveHost: () => undefined }).request(url(), { headers: keyHeaders })).status, 403);
});

test("config 403s a host the auth refuses", async () => {
  const app = appWith({ auth: async () => ({ ok: false, status: 403, error: "host not served" }) });
  assert.equal((await app.request(url(), { headers: keyHeaders })).status, 403);
});

test("config returns rules, the x402 manifest and the RSL licence for the authed host", async () => {
  const res = await appWith().request(url(), { headers: keyHeaders });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, any>;
  assert.deepEqual(body.enforcement.articlePrefixes, ["essays"]);
  assert.deepEqual(body.enforcement.crawlerPolicy.charge, ["oai-searchbot"]);
  assert.deepEqual(body.rules.charge, ["oai-searchbot"]);
  assert.equal(body.rules.tollMode, "charge");
  assert.ok(body.manifest, "the x402 manifest rides along");
  assert.match(body.license, /<rsl /);
  assert.match(body.license, /h\.test/);
});

test("no secret field from the resolved publisher reaches the runtime", async () => {
  const text = await (await appWith().request(url(), { headers: keyHeaders })).text();
  assert.ok(!text.includes("secret-a") && !text.includes("secret-b"));
});

test("a publisher that set no policy sends no key rather than an explicit null", async () => {
  const bare = publisherOf("pub_a", { seoAllowlist: undefined, crawlerPolicy: undefined, gateScope: undefined, termsPolicy: undefined });
  const body = (await (await appWith({ resolveHost: () => bare }).request(url(), { headers: keyHeaders })).json()) as Record<string, any>;
  for (const k of ["seoAllowlist", "crawlerPolicy", "gateScope", "termsPolicy"]) {
    assert.ok(!(k in body.enforcement), `${k} must be absent`);
  }
});

test("the response is never stored by an intermediary", async () => {
  const res = await appWith().request(url(), { headers: keyHeaders });
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("an owned host the resolver does not route resolves through resolveByOwner", async () => {
  const app = appWith({
    resolveHost: () => undefined,
    hooks: { resolveByOwner: async (id, host) => (id === "pub_a" && host === "inapp.test" ? publisherOf("pub_a") : undefined) },
  });
  const res = await app.request(url("https://inapp.test/essays/x"), { headers: keyHeaders });
  assert.equal(res.status, 200);
});

test("a served config stamps the install heartbeat; a refused one stamps nothing", async () => {
  const stamps: string[] = [];
  const hooks = { stampInAppConfig: (id: string, host: string) => { stamps.push(`${id}@${host}`); } };
  await appWith({ hooks }).request(url(), { headers: keyHeaders });
  await appWith({ hooks }).request(url());
  await appWith({ hooks, resolveHost: () => publisherOf("pub_b") }).request(url(), { headers: keyHeaders });
  assert.deepEqual(stamps, ["pub_a@h.test"]);
});

test("the fleet's signing agent and this publisher's id reach the runtime together", async () => {
  const body = (await (await appWith({ fleetAgent: "gate.example" }).request(url(), { headers: keyHeaders })).json()) as Record<string, any>;
  assert.equal(body.enforcement.fleetAgent, "gate.example");
  assert.equal(body.enforcement.fleetPublisher, "pub_a");
});

test("armed identity is sent, empty included, when the host knows it", async () => {
  const body = (await (await appWith({ hooks: { armedFor: () => [] } }).request(url(), { headers: keyHeaders })).json()) as Record<string, any>;
  assert.deepEqual(body.identity, { armed: [] });
});

test("fleetAgentHost is the bare host, and only when the gate signs", () => {
  assert.equal(fleetAgentHost("k", "https://Gate.Example/path"), "gate.example");
  assert.equal(fleetAgentHost(undefined, "gate.example"), undefined);
  assert.equal(fleetAgentHost("k", undefined), undefined);
});

test("status answers a valid key with selfHosted from auth", async () => {
  const res = await appWith().request("/_naulon/enforce-status", { headers: keyHeaders });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hosts: [], attention: false, selfHosted: true });
});

test("status refuses a missing key", async () => {
  assert.equal((await appWith().request("/_naulon/enforce-status")).status, 401);
});

test("a per-site key digest never reaches the runtime", async () => {
  const withDigest = publisherOf("pub_a", { enforceKeySha256: "d".repeat(64) });
  const text = await (await appWith({ resolveHost: () => withDigest }).request(url(), { headers: keyHeaders })).text();
  assert.ok(!text.includes("d".repeat(64)));
});

test("status offers the resource's host to auth, so a per-site key can be checked", async () => {
  const seen: (string | null)[] = [];
  const app = appWith({ auth: async (_c, host) => { seen.push(host); return { ok: true, publisherId: "pub_a", selfHosted: true }; } });
  await app.request(`/_naulon/enforce-status?resource=${encodeURIComponent("https://Site.Example/")}`, { headers: keyHeaders });
  await app.request("/_naulon/enforce-status", { headers: keyHeaders });
  assert.deepEqual(seen, ["site.example", null]);
});

test("status carries the host's own report when it has one", async () => {
  const app = appWith({
    auth: async () => ({ ok: true, publisherId: "pub_a", selfHosted: false }),
    hooks: { statusReport: async (id) => ({ hosts: [{ host: `${id}.test`, nextAction: "none" }], attention: false }) },
  });
  const res = await app.request("/_naulon/enforce-status", { headers: keyHeaders });
  assert.deepEqual(await res.json(), { hosts: [{ host: "pub_a.test", nextAction: "none" }], attention: false, selfHosted: false });
});

test("status passes the auth refusal through, so a key for the wrong site is a 403 not a 401", async () => {
  const app = appWith({ auth: async () => ({ ok: false, status: 403, error: "resource not owned by this key" }) });
  assert.equal((await app.request("/_naulon/enforce-status", { headers: keyHeaders })).status, 403);
});

test("a host's status row schema and summary reach the OpenAPI document", async () => {
  const { z } = await import("@hono/zod-openapi");
  const app = new OpenAPIHono();
  mountEnforceApi(app, {
    resolver: { resolve: async () => undefined },
    auth: keyAuth(),
    observe: () => {},
    docs: { statusSummary: "Per-host enforcement report", statusRow: z.object({ host: z.string(), nextAction: z.string() }).openapi("StatusRowTest") },
  });
  const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } }) as { paths: Record<string, { get?: { summary?: string } }>; components?: { schemas?: Record<string, unknown> } };
  assert.equal(doc.paths["/_naulon/enforce-status"]?.get?.summary, "Per-host enforcement report");
  assert.ok(doc.components?.schemas?.StatusRowTest, "the row schema is documented");
});
