import assert from "node:assert/strict";
import { test } from "node:test";
import { httpPublisherResolver } from "./httpPublisherResolver.ts";

const RECORD = {
  id: "blog-1",
  hosts: ["one.example"],
  originUrl: "https://one.example",
  articlePrefixes: [],
  priceMicro: 5000,
};

interface Seen { url: string; auth: string | null }

function fakeFetch(responses: (() => Response)[], seen: Seen[] = []): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error("no response queued");
    return next();
  }) as typeof fetch;
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("sends the bearer key and the host as ?host=", async () => {
  const seen: Seen[] = [];
  const r = httpPublisherResolver({ url: "https://platform.example/naulon/publisher", key: "k1", fetch: fakeFetch([ok(RECORD)], seen) });
  const cfg = await r.resolve("One.Example");
  assert.equal(cfg?.id, "blog-1");
  assert.equal(seen[0]?.url, "https://platform.example/naulon/publisher?host=one.example");
  assert.equal(seen[0]?.auth, "Bearer k1");
});

test("caches per host for ttlMs", async () => {
  const seen: Seen[] = [];
  let now = 0;
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", ttlMs: 1000, now: () => now, fetch: fakeFetch([ok(RECORD)], seen) });
  await r.resolve("one.example");
  now = 999;
  await r.resolve("one.example");
  assert.equal(seen.length, 1);
  now = 1001;
  await r.resolve("one.example");
  assert.equal(seen.length, 2);
});

test("serves the last good record when the platform 500s", async () => {
  let now = 0;
  const r = httpPublisherResolver({
    url: "https://p.example/x", key: "k", ttlMs: 10, now: () => now,
    fetch: fakeFetch([ok(RECORD), () => new Response("boom", { status: 500 })]),
  });
  await r.resolve("one.example");
  now = 100;
  assert.equal((await r.resolve("one.example"))?.id, "blog-1");
});

test("serves the last good record when the platform is unreachable", async () => {
  let now = 0;
  let calls = 0;
  const r = httpPublisherResolver({
    url: "https://p.example/x", key: "k", ttlMs: 10, now: () => now,
    fetch: (async () => { if (calls++ === 0) return ok(RECORD)(); throw new TypeError("fetch failed"); }) as typeof fetch,
  });
  await r.resolve("one.example");
  now = 100;
  assert.equal((await r.resolve("one.example"))?.id, "blog-1");
});

test("returns undefined on 404", async () => {
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", fetch: fakeFetch([() => new Response("", { status: 404 })]) });
  assert.equal(await r.resolve("gone.example"), undefined);
});

test("a 404 after a good record means the platform withdrew it", async () => {
  let now = 0;
  const r = httpPublisherResolver({
    url: "https://p.example/x", key: "k", ttlMs: 10, now: () => now,
    fetch: fakeFetch([ok(RECORD), () => new Response("", { status: 404 })]),
  });
  await r.resolve("one.example");
  now = 100;
  assert.equal(await r.resolve("one.example"), undefined);
});

test("returns the last good record and logs once when the body fails the schema", async () => {
  let now = 0;
  const logged: string[] = [];
  const r = httpPublisherResolver({
    url: "https://p.example/x", key: "k", ttlMs: 10, now: () => now,
    log: (m) => logged.push(m),
    fetch: fakeFetch([ok(RECORD), ok({ ...RECORD, priceMicro: 1.5 })]),
  });
  await r.resolve("one.example");
  now = 100;
  assert.equal((await r.resolve("one.example"))?.id, "blog-1");
  now = 200;
  await r.resolve("one.example");
  assert.equal(logged.length, 1);
});

test("a record that does not list the asked host is refused", async () => {
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", fetch: fakeFetch([ok({ ...RECORD, hosts: ["other.example"] })]) });
  assert.equal(await r.resolve("one.example"), undefined);
});

test("an invalid host never reaches the platform", async () => {
  const seen: Seen[] = [];
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", fetch: fakeFetch([ok(RECORD)], seen) });
  for (const bad of ["", "a b.example", "x.example/path", "x.example?host=y", "a..b.example", `${"a".repeat(254)}.example`, "x.example:99999"]) {
    assert.equal(await r.resolve(bad), undefined, bad);
  }
  assert.equal(seen.length, 0);
});

test("a trailing dot names the same host", async () => {
  const seen: Seen[] = [];
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", fetch: fakeFetch([ok(RECORD)], seen) });
  await r.resolve("one.example.");
  await r.resolve("one.example");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://p.example/x?host=one.example");
});

test("concurrent resolves for one host make one platform fetch", async () => {
  const seen: Seen[] = [];
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", fetch: fakeFetch([ok(RECORD)], seen) });
  await Promise.all([r.resolve("one.example"), r.resolve("one.example"), r.resolve("one.example")]);
  assert.equal(seen.length, 1);
});

test("the cache holds at most maxEntries hosts, evicting the least recently used", async () => {
  const seen: Seen[] = [];
  const r = httpPublisherResolver({ url: "https://p.example/x", key: "k", maxEntries: 2, fetch: fakeFetch([() => new Response("", { status: 404 })], seen) });
  await r.resolve("a.example");
  await r.resolve("b.example");
  await r.resolve("a.example");
  await r.resolve("c.example");
  assert.equal(seen.length, 3, "a was used last, so b is the one evicted");
  await r.resolve("a.example");
  assert.equal(seen.length, 3);
  await r.resolve("b.example");
  assert.equal(seen.length, 4);
});

test("during a platform outage an unknown host is not re-fetched on every request, and nothing grows without bound", async () => {
  const seen: Seen[] = [];
  const logged: string[] = [];
  let now = 0;
  const r = httpPublisherResolver({
    url: "https://p.example/x", key: "k", maxEntries: 3, now: () => now, log: (m) => logged.push(m),
    fetch: fakeFetch([() => new Response("down", { status: 503 })], seen),
  });
  await r.resolve("a.example");
  await r.resolve("a.example");
  assert.equal(seen.length, 1, "a failed lookup is remembered briefly");
  now = 10_000;
  await r.resolve("a.example");
  assert.equal(seen.length, 2, "and retried once that window passes");
  for (let i = 0; i < 50; i++) await r.resolve(`h${i}.example`);
  assert.ok(logged.length <= 50 + 2);
  const internals = r as unknown as { stats?: () => { cached: number; warned: number } };
  assert.ok(internals.stats, "the resolver exposes its sizes for this test");
  const { cached, warned } = internals.stats();
  assert.ok(cached <= 3 && warned <= 3, `cached ${cached}, warned ${warned}`);
});
