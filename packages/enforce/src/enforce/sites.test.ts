import { test } from "node:test";
import assert from "node:assert/strict";

import { naulonSites } from "./sites.ts";

const KEYS: Record<string, string> = { "alice.blog.test": "nln_alice", "bob.blog.test": "nln_bob" };

const DOC = {
  enforcement: {
    articlePrefixes: ["essays"],
    gateScope: { mode: "prefix" },
    licenseIdentity: "naulon:site.test",
  },
};
const QUOTE = {
  slug: "essays/x",
  kind: "read",
  title: "X",
  price: 5000,
  payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
  extraLegs: [],
  coauthorSplit: false,
};

/** A gate that answers every path and remembers which key each call carried. */
function fakeGate(over: { config?: (key: string | null) => unknown } = {}) {
  const calls: { path: string; key: string | null; host: string | null }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const auth = new Headers(init?.headers).get("authorization");
    const key = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const resource = url.searchParams.get("resource");
    calls.push({ path: url.pathname, key, host: resource ? new URL(resource).host : null });
    if (url.pathname === "/_naulon/enforce-config") {
      return new Response(JSON.stringify(over.config ? over.config(key) : DOC), { status: 200 });
    }
    if (url.pathname === "/_naulon/quote") return new Response(JSON.stringify(QUOTE), { status: 200 });
    if (url.pathname.endsWith("naulon-jwks.json")) return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const agent = (host: string, path = "/essays/x") => new Request(`http://${host}${path}`, { headers: { "user-agent": "GPTBot/1.0" } });

/** The config source fetches on first sight and serves what it holds; give it a turn to land. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

test("a site without a key is never touched: not one call to the gate", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: (h) => KEYS[h], fetchImpl });
  const out = await toll(agent("carol.blog.test"));
  assert.equal(out.response, null);
  assert.deepEqual(calls, []);
});

test("each site is tolled under its own key", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
  await toll(agent("alice.blog.test"));
  await toll(agent("bob.blog.test"));
  await settle();
  const a = await toll(agent("alice.blog.test"));
  const b = await toll(agent("bob.blog.test"));
  assert.equal(a.response?.status, 402);
  assert.equal(b.response?.status, 402);
  const keysOn = (p: string) => [...new Set(calls.filter((c) => c.path === p).map((c) => `${c.host}=${c.key}`))].sort();
  const expected = ["alice.blog.test=nln_alice", "bob.blog.test=nln_bob"];
  assert.deepEqual(keysOn("/_naulon/enforce-config"), expected);
  assert.deepEqual(keysOn("/_naulon/quote"), expected);
  assert.ok(calls.every((c) => c.path.endsWith("naulon-jwks.json") || c.key !== null), "every site call carries a key");
});

test("one host's policy under one key never answers another key", async () => {
  const { fetchImpl } = fakeGate({
    config: (key) => (key === "nln_alice" ? DOC : { enforcement: { ...DOC.enforcement, articlePrefixes: ["nothing-here"] } }),
  });
  let current = "nln_alice";
  const toll = naulonSites({ gate: "http://gate", keyFor: () => current, fetchImpl, crawlerRanges: false, keyTtlMs: 0 });
  await toll(agent("shared.test"));
  await settle();
  assert.equal((await toll(agent("shared.test"))).response?.status, 402, "alice's policy tolls /essays");
  current = "nln_bob";
  await toll(agent("shared.test"));
  await settle();
  assert.equal((await toll(agent("shared.test"))).response, null, "bob's policy does not, and alice's is not reused");
});

test("the platform's lookup runs once per host per interval", async () => {
  let now = 0;
  const asked: string[] = [];
  const { fetchImpl } = fakeGate();
  const toll = naulonSites({
    gate: "http://gate",
    keyFor: (h) => {
      asked.push(h);
      return KEYS[h];
    },
    fetchImpl,
    now: () => now,
    crawlerRanges: false,
  });
  for (let i = 0; i < 5; i++) await toll(agent("Alice.Blog.Test"));
  assert.deepEqual(asked, ["alice.blog.test"]);
  now = 31_000;
  await toll(agent("alice.blog.test"));
  assert.deepEqual(asked, ["alice.blog.test", "alice.blog.test"], "a changed or revoked key lands within the interval");
});

test("a lookup that throws, or answers junk, serves the page", async () => {
  const { calls, fetchImpl } = fakeGate();
  const original = console.error;
  console.error = () => {};
  try {
    for (const keyFor of [
      () => {
        throw new Error("database down");
      },
      async () => "   ",
      () => 7 as unknown as string,
    ]) {
      const toll = naulonSites({ gate: "http://gate", keyFor, fetchImpl });
      assert.equal((await toll(agent("alice.blog.test"))).response, null);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(calls, []);
});

test("an async lookup works", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: async (h) => KEYS[h] ?? null, fetchImpl, crawlerRanges: false });
  await toll(agent("bob.blog.test"));
  await settle();
  assert.equal((await toll(agent("bob.blog.test"))).response?.status, 402);
  assert.ok(calls.some((c) => c.key === "nln_bob"));
});

test("a person on a keyed site is untouched", async () => {
  const { fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
  const person = new Request("http://alice.blog.test/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } });
  await toll(person);
  await settle();
  assert.equal((await toll(person)).response, null);
});

test("the gate's keys are fetched once for every site", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
  for (const host of Object.keys(KEYS)) {
    await toll(agent(host));
    await settle();
    await toll(agent(host));
  }
  await settle();
  assert.equal(calls.filter((c) => c.path.endsWith("naulon-jwks.json")).length, 1);
});

test("engines are kept for the most recently active sites only", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "http://gate", keyFor: (h) => `nln_${h}`, fetchImpl, crawlerRanges: false, maxSites: 2 });
  for (const h of ["a.test", "b.test", "c.test"]) await toll(agent(h));
  await settle();
  const configs = () => calls.filter((c) => c.path === "/_naulon/enforce-config").length;
  const before = configs();
  await toll(agent("a.test")); // pushed out by c.test: rebuilt, so its policy is fetched again
  await settle();
  assert.equal(configs(), before + 1);
});
