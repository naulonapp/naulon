import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountFromHostedDeps as mountEnforceObserve } from "./hostedDeps.testkit.ts";
import type { InAppObservation } from "./index.ts";

const publisherOf = (id: string) => ({ id, originUrl: "http://o", articlePrefixes: ["essays"] }) as never;

function appWith(opts: {
  resolveHost?: (host: string) => unknown;
  resolveKey?: (token: string) => { tenantId: string; ownerUserId: string; scopes: string[] } | null;
  now?: () => number;
  ownsVerifiedHost?: (tenantId: string, host: string) => Promise<boolean>;
  resolveByTenant?: (tenantId: string, host: string) => Promise<unknown>;
  stampInApp?: (tenantId: string, host: string, atMs: number) => void;
  recordIdentity?: (publisherId: string, result: { check: string; claims: { operatorId: string }[] }, at: number) => void;
}) {
  const seen: InAppObservation[] = [];
  const app = new OpenAPIHono();
  mountEnforceObserve(app, {
    resolver: { resolve: async (host: string) => (opts.resolveHost ? opts.resolveHost(host) : publisherOf("pub_a")) } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async (token: string) =>
      opts.resolveKey ? opts.resolveKey(token) : { tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] }) as never,
    observe: (o) => void seen.push(o),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.ownsVerifiedHost ? { ownsVerifiedHost: opts.ownsVerifiedHost } : {}),
    ...(opts.resolveByTenant ? { resolveByTenant: opts.resolveByTenant as never } : {}),
    ...(opts.stampInApp ? { stampInApp: opts.stampInApp } : {}),
    ...(opts.recordIdentity ? { recordIdentity: opts.recordIdentity as never } : {}),
  });
  return { app, seen };
}

const keyHeaders = { authorization: "Bearer nln_live_test", "content-type": "application/json" };

const report = (over?: Record<string, unknown>) =>
  JSON.stringify({
    resource: "http://h.test/essays/x",
    slug: "essays/x",
    verdict: "denied",
    classifiedAs: "agent",
    kind: "read",
    priceMicro: 1000,
    ...over,
  });

const post = (app: OpenAPIHono, body: string, headers: Record<string, string> = keyHeaders) =>
  app.request("/_naulon/observe", { method: "POST", headers, body });

test("missing key → 401, before any body validation", async () => {
  const { app, seen } = appWith({});
  const res = await post(app, "{}", { "content-type": "application/json" });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0);
});

test("a reported denial is written, attributed to the key's tenant", async () => {
  const { app, seen } = appWith({});
  const res = await post(app, report());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, accepted: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.verdict, "denied");
  assert.equal(seen[0]?.publisherId, "pub_a");
  assert.equal(seen[0]?.host, "h.test");
  assert.equal(seen[0]?.slug, "essays/x");
  assert.equal(seen[0]?.kind, "read");
});

test("priceMicro is integer micro-USDC on the wire, whole USDC in the observation", async () => {
  const { app, seen } = appWith({});
  await post(app, report({ priceMicro: 3000 }));
  assert.equal(seen[0]?.priceUsdc, 0.003);
});

// ── The integrity line ────────────────────────────────────────────────────────
// A tenant is the only witness to its own traffic, so it may describe it. It is NOT
// the witness to its own settlements — those are the cloud's, written by /verify.

test("verdict `paid` is REFUSED with a reason — a tenant cannot mint earnings", async () => {
  const { app, seen } = appWith({});
  const res = await post(app, report({ verdict: "paid" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /written by \/verify/);
  assert.equal(seen.length, 0);
});

test("verdict `payment-failed` is refused for the same reason", async () => {
  const { app, seen } = appWith({});
  assert.equal((await post(app, report({ verdict: "payment-failed" }))).status, 400);
  assert.equal(seen.length, 0);
});

test("a money verdict ANYWHERE in a batch rejects the whole batch — no partial write", async () => {
  const { app, seen } = appWith({});
  const res = await post(app, JSON.stringify([JSON.parse(report()), JSON.parse(report({ verdict: "paid" }))]));
  assert.equal(res.status, 400);
  assert.equal(seen.length, 0);
});

// ── Isolation ─────────────────────────────────────────────────────────────────

test("cross-tenant: a host owned by another publisher → 403, nothing written", async () => {
  const { app, seen } = appWith({ resolveHost: () => publisherOf("pub_b") });
  assert.equal((await post(app, report())).status, 403);
  assert.equal(seen.length, 0);
});

test("unknown host → 403", async () => {
  const { app } = appWith({ resolveHost: () => undefined });
  assert.equal((await post(app, report())).status, 403);
});

test("EVERY host in a batch is ownership-checked, not just the first", async () => {
  const { app, seen } = appWith({
    resolveHost: (host: string) => (host === "h.test" ? publisherOf("pub_a") : publisherOf("pub_b")),
  });
  const res = await post(
    app,
    JSON.stringify([JSON.parse(report()), JSON.parse(report({ resource: "http://other.test/essays/y" }))]),
  );
  assert.equal(res.status, 403);
  // The owned report must NOT have landed: a partial write leaves the caller unable to
  // tell what was accepted.
  assert.equal(seen.length, 0);
});

test("publisherId is the authenticated tenant, never what the body claims", async () => {
  const { app, seen } = appWith({});
  await post(app, report({ publisherId: "pub_evil", host: "evil.test" }));
  assert.equal(seen[0]?.publisherId, "pub_a");
  assert.equal(seen[0]?.host, "h.test");
});

test("an in-app host absent from hosts[] resolves via proven ownership (the /quote deadlock-breaker)", async () => {
  const { app, seen } = appWith({
    resolveHost: () => undefined,
    ownsVerifiedHost: async () => true,
    resolveByTenant: async (tenantId: string) => publisherOf(tenantId),
  });
  assert.equal((await post(app, report())).status, 202);
  assert.equal(seen.length, 1);
});

// ── Timestamps ────────────────────────────────────────────────────────────────

test("no `at` → stamped now", async () => {
  const { app, seen } = appWith({ now: () => 1_000_000 });
  await post(app, report());
  assert.equal(seen[0]?.at, 1_000_000);
});

test("a recent `at` is honored (a buffered/retried batch is legitimately a little old)", async () => {
  const now = 10_000_000_000;
  const { app, seen } = appWith({ now: () => now });
  await post(app, report({ at: now - 60_000 }));
  assert.equal(seen[0]?.at, now - 60_000);
});

test("an ancient `at` is clamped to now — no writing into a closed reporting window", async () => {
  const now = 10_000_000_000;
  const { app, seen } = appWith({ now: () => now });
  await post(app, report({ at: 1 }));
  assert.equal(seen[0]?.at, now);
});

test("a future-dated `at` beyond tolerated skew is clamped to now", async () => {
  const now = 10_000_000_000;
  const { app, seen } = appWith({ now: () => now });
  await post(app, report({ at: now + 86_400_000 }));
  assert.equal(seen[0]?.at, now);
});

// ── Shape ─────────────────────────────────────────────────────────────────────

test("a batch is accepted and every entry written", async () => {
  const { app, seen } = appWith({});
  const res = await post(
    app,
    JSON.stringify([
      JSON.parse(report()),
      JSON.parse(report({ verdict: "served-free", classifiedAs: "human" })),
      JSON.parse(report({ verdict: "blocked" })),
    ]),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, accepted: 3 });
  assert.deepEqual(seen.map((o) => o.verdict), ["denied", "served-free", "blocked"]);
});

test("a batch over the cap is rejected", async () => {
  const { app, seen } = appWith({});
  const many = Array.from({ length: 51 }, () => JSON.parse(report()));
  assert.equal((await post(app, JSON.stringify(many))).status, 400);
  assert.equal(seen.length, 0);
});

test("an empty batch is rejected", async () => {
  const { app } = appWith({});
  assert.equal((await post(app, "[]")).status, 400);
});

test("a bad resource URL → 400", async () => {
  const { app } = appWith({});
  assert.equal((await post(app, report({ resource: "not-a-url" }))).status, 400);
});

test("an unknown verdict → 400", async () => {
  const { app } = appWith({});
  assert.equal((await post(app, report({ verdict: "made-up" }))).status, 400);
});

test("a negative price → 400 (a would-have-paid figure is never negative)", async () => {
  const { app } = appWith({});
  assert.equal((await post(app, report({ priceMicro: -1 }))).status, 400);
});

test("a fractional priceMicro → 400 (money is integer micro-USDC)", async () => {
  const { app } = appWith({});
  assert.equal((await post(app, report({ priceMicro: 1.5 }))).status, 400);
});

test("slug is optional — a gated non-article path reports an empty slug", async () => {
  const { app, seen } = appWith({});
  await post(app, report({ slug: undefined }));
  assert.equal(seen[0]?.slug, "");
});

test("the agent block rides through for the per-agent rollup", async () => {
  const { app, seen } = appWith({});
  await post(app, report({ agent: { ua: "GPTBot/1.0", classifyReason: "ua-pattern:bot", sigInvalid: true } }));
  assert.equal(seen[0]?.agent?.ua, "GPTBot/1.0");
  assert.equal(seen[0]?.agent?.sigInvalid, true);
});

/* `unservable` is a statement about the gate's own ordering: it fetched the origin, could not serve,
 * and declined to settle. An in-app runtime serves its own content and cannot witness it, so it is
 * refused for the same reason as the money verdicts. */
test("verdict `unservable` is refused — an in-app runtime cannot witness the gate's settle ordering", async () => {
  const { app, seen } = appWith({});
  const res = await post(app, report({ verdict: "unservable" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /written by \/verify/);
  assert.equal(seen.length, 0, "and nothing is written");
});

/* ── the toll heartbeat on /observe ─────────────────────────────────────────────────────────────
 *
 * An observation is a gating decision the runtime already took about a declared agent, the same
 * evidence `/quote` stamps, arriving after the fact instead of before it. */

test("an accepted report stamps the toll heartbeat with the server's clock", async () => {
  const seen: Array<[string, string, number]> = [];
  const { app } = appWith({ now: () => 1_700_000_000_000, stampInApp: (t, h, at) => seen.push([t, h, at]) });
  const res = await app.request("/_naulon/observe", { method: "POST", headers: keyHeaders, body: report() });
  assert.equal(res.status, 202);
  assert.deepEqual(seen, [["pub_a", "h.test", 1_700_000_000_000]]);
});

test("a client-supplied `at` never becomes the heartbeat — it is clamped, not trusted", async () => {
  const seen: number[] = [];
  const { app } = appWith({ now: () => 1_700_000_000_000, stampInApp: (_t, _h, at) => seen.push(at) });
  await app.request("/_naulon/observe", {
    method: "POST",
    headers: keyHeaders,
    body: report({ at: 1_699_000_000_000 }),
  });
  assert.deepEqual(seen, [1_700_000_000_000]);
});

test("a cross-tenant report stamps nothing", async () => {
  const seen: string[] = [];
  const { app } = appWith({ resolveHost: () => publisherOf("pub_b"), stampInApp: (_t, h) => seen.push(h) });
  const res = await app.request("/_naulon/observe", { method: "POST", headers: keyHeaders, body: report() });
  assert.equal(res.status, 403);
  assert.deepEqual(seen, []);
});

test("identity fields are stored, validated, and arm only the reporting tenant", async () => {
  const recorded: string[] = [];
  const { app, seen } = appWith({ recordIdentity: (pub, r) => void recorded.push(`${pub}:${r.claims[0]!.operatorId}:${r.check}`) });
  const rows = [
    { verdict: "served-free", classifiedAs: "human", identityCheck: "ip-verified", claimedOperator: "google" },
    { identityCheck: "forged", claimedOperator: "google", forgedFrom: "9.9.9.0/24" },
    { identityCheck: "forged", claimedOperator: "google", forgedFrom: "9.9.9.9" },
    { verdict: "served-free", classifiedAs: "human", identityCheck: "ip-verified", claimedOperator: "not-a-crawler" },
    { verdict: "served-free", classifiedAs: "human", identityCheck: "ip-verified", claimedOperator: "google", forgedFrom: "9.9.9.0/24" },
    { identityCheck: "forged", claimedOperator: "google", forgedFrom: "2a01:4f8:c0c::/48" },
  ].map((over) => JSON.parse(report(over)));
  const res = await post(app, JSON.stringify(rows));
  assert.equal(res.status, 202);
  assert.equal(seen[0]!.identityCheck, "ip-verified");
  assert.equal(seen[0]!.claimedOperator, "google");
  assert.equal(seen[1]!.forgedFrom, "9.9.9.0/24");
  assert.equal(seen[2]!.forgedFrom, undefined, "a full address is never stored");
  assert.equal(seen[3]!.claimedOperator, undefined, "an unknown operator is dropped");
  assert.equal(seen[4]!.forgedFrom, undefined, "forgedFrom rides only on a forged row");
  assert.equal(seen[5]!.forgedFrom, "2a01:4f8:c0c::/48");
  assert.deepEqual(recorded, [
    "pub_a:google:ip-verified",
    "pub_a:google:forged",
    "pub_a:google:forged",
    "pub_a:google:ip-verified",
    "pub_a:google:forged",
  ]);
});

test("a report with no identity check records nothing toward arming", async () => {
  const recorded: string[] = [];
  const { app } = appWith({ recordIdentity: (pub) => void recorded.push(pub) });
  assert.equal((await post(app, report())).status, 202);
  assert.deepEqual(recorded, []);
});

test("forgedFrom with an IPv4 octet over 255 is dropped", async () => {
  const { app, seen } = appWith({});
  const body = JSON.stringify([JSON.parse(report({ identityCheck: "forged", claimedOperator: "google", forgedFrom: "999.1.1.0/24" }))]);
  assert.equal((await post(app, body)).status, 202);
  assert.equal(seen[0]!.forgedFrom, undefined);
});

test("observe fields are stored on a denied row and dropped anywhere they could not be true", async () => {
  const { app, seen } = appWith({});
  const rows = [
    { observeOnly: true, crawlerBudget: "within" },
    { observeOnly: true, paymentPresented: true },
    { crawlerBudget: "over" },
    { verdict: "served-free", classifiedAs: "human", observeOnly: true, crawlerBudget: "within", paymentPresented: true },
    { paymentPresented: true },
    { crawlerBudget: "maybe" },
  ].map((over) => JSON.parse(report(over)));
  const res = await post(app, JSON.stringify(rows));
  assert.equal(res.status, 202);
  assert.equal(seen[0]!.observeOnly, true);
  assert.equal(seen[0]!.crawlerBudget, "within");
  assert.equal(seen[1]!.paymentPresented, true);
  assert.equal(seen[2]!.crawlerBudget, "over", "a stated budget is a fact in either mode");
  assert.equal(seen[2]!.observeOnly, undefined);
  assert.equal(seen[3]!.observeOnly, undefined, "only a priced read can be observed");
  assert.equal(seen[3]!.crawlerBudget, undefined);
  assert.equal(seen[4]!.paymentPresented, undefined, "a payment the site did not settle exists only while observing");
  assert.equal(seen[5]!.crawlerBudget, undefined, "an unknown budget verdict is dropped, not a 400");
});

test("freeReason is stored on an agent's free read and dropped anywhere it could not be true", async () => {
  const { app, seen } = appWith({});
  const rows = [
    { verdict: "served-free", classifiedAs: "agent", freeReason: "terms" },
    { verdict: "served-free", classifiedAs: "agent", freeReason: "unpriced" },
    { verdict: "served-free", classifiedAs: "human", freeReason: "terms" },
    { verdict: "denied", classifiedAs: "agent", freeReason: "unpriced" },
    { verdict: "served-free", classifiedAs: "agent", freeReason: "because" },
  ].map((over) => JSON.parse(report(over)));
  const res = await post(app, JSON.stringify(rows));
  assert.equal(res.status, 202);
  assert.equal(seen[0]!.freeReason, "terms");
  assert.equal(seen[1]!.freeReason, "unpriced");
  assert.equal(seen[2]!.freeReason, undefined, "a person reads free without a reason");
  assert.equal(seen[3]!.freeReason, undefined, "a refused read was not free");
  assert.equal(seen[4]!.freeReason, undefined, "an unknown reason is dropped, not a 400");
});
