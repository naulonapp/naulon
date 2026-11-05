import { test } from "node:test";
import assert from "node:assert/strict";

import { naulonSite, naulonSites } from "./sites.ts";
import { naulonConnect } from "../connect/connect.ts";

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

test("a site without a credential is never touched: not one call to the gate", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: (h) => KEYS[h], fetchImpl });
  const out = await toll(agent("carol.blog.test"));
  assert.equal(out.response, null);
  assert.deepEqual(calls, []);
});

test("each site is tolled under its own credential", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
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

test("one host's policy under one credential never answers another", async () => {
  const { fetchImpl } = fakeGate({
    config: (key) => (key === "nln_alice" ? DOC : { enforcement: { ...DOC.enforcement, articlePrefixes: ["nothing-here"] } }),
  });
  let current = "nln_alice";
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: () => current, fetchImpl, crawlerRanges: false, credentialTtlMs: 0 });
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
    gate: "https://gate.test",
    credentialFor: (h) => {
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
  assert.deepEqual(asked, ["alice.blog.test", "alice.blog.test"], "a changed or revoked credential lands within the interval");
});

test("a lookup that throws, or answers junk, serves the page", async () => {
  const { calls, fetchImpl } = fakeGate();
  const original = console.error;
  console.error = () => {};
  try {
    for (const credentialFor of [
      () => {
        throw new Error("database down");
      },
      async () => "   ",
      () => 7 as unknown as string,
    ]) {
      const toll = naulonSites({ gate: "https://gate.test", credentialFor, fetchImpl });
      assert.equal((await toll(agent("alice.blog.test"))).response, null);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(calls, []);
});

test("an async lookup works", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: async (h) => KEYS[h] ?? null, fetchImpl, crawlerRanges: false });
  await toll(agent("bob.blog.test"));
  await settle();
  assert.equal((await toll(agent("bob.blog.test"))).response?.status, 402);
  assert.ok(calls.some((c) => c.key === "nln_bob"));
});

test("a person on a connected site is untouched", async () => {
  const { fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
  const person = new Request("http://alice.blog.test/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } });
  await toll(person);
  await settle();
  assert.equal((await toll(person)).response, null);
});

test("the gate's keys are fetched once for every site", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: (h) => KEYS[h], fetchImpl, crawlerRanges: false });
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
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: (h) => `nln_${h}`, fetchImpl, crawlerRanges: false, maxSites: 2 });
  for (const h of ["a.test", "b.test", "c.test"]) await toll(agent(h));
  await settle();
  const configs = () => calls.filter((c) => c.path === "/_naulon/enforce-config").length;
  const before = configs();
  await toll(agent("a.test")); // pushed out by c.test: rebuilt, so its policy is fetched again
  await settle();
  assert.equal(configs(), before + 1);
});

/** Two gates behind one fetch, told apart by origin. */
function twoGates() {
  const a = fakeGate();
  const b = fakeGate();
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    return url.origin === "https://own-gate.test" ? b.fetchImpl(input, init) : a.fetchImpl(input, init);
  }) as typeof fetch;
  return { platform: a.calls, own: b.calls, fetchImpl };
}

test("a site connected to its own gate is tolled there, and that gate's keys are its own", async () => {
  const { platform, own, fetchImpl } = twoGates();
  const toll = naulonSites({
    gate: "https://gate.test",
    credentialFor: (h) => (h === "alice.blog.test" ? { credential: "nln_alice", gate: "https://own-gate.test/" } : KEYS[h]),
    fetchImpl,
    crawlerRanges: false,
  });
  for (const h of ["alice.blog.test", "bob.blog.test"]) {
    await toll(agent(h));
    await settle();
    assert.equal((await toll(agent(h))).response?.status, 402, h);
  }
  assert.ok(own.length > 0 && own.every((c) => c.path.endsWith("naulon-jwks.json") || c.key === "nln_alice"), "alice only on her gate");
  assert.ok(platform.every((c) => c.key !== "nln_alice"), "alice's credential never reaches the platform's gate");
  assert.equal(own.filter((c) => c.path.endsWith("naulon-jwks.json")).length, 1);
  assert.equal(platform.filter((c) => c.path.endsWith("naulon-jwks.json")).length, 1);
});

test("a site whose saved gate is not https is served untouched", async () => {
  const { calls, fetchImpl } = fakeGate();
  const original = console.error;
  const said: string[] = [];
  console.error = (m: string) => void said.push(m);
  try {
    const toll = naulonSites({ gate: "https://gate.test", credentialFor: () => ({ credential: "nln_x", gate: "http://evil.test" }), fetchImpl });
    assert.equal((await toll(agent("alice.blog.test"))).response, null);
  } finally {
    console.error = original;
  }
  assert.deepEqual(calls, []);
  assert.match(said[0] ?? "", /is not an https URL; that site is served untouched/);
});

test("a gate a writer named is reached only through the guard, and a refusal serves the page", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    // No fetchImpl: the real paths. A private address is refused before any socket opens.
    const toll = naulonSites({ gate: "https://gate.test", credentialFor: () => ({ credential: "nln_x", gate: "https://10.0.0.1" }), crawlerRanges: false });
    await toll(agent("alice.blog.test"));
    await settle();
    assert.equal((await toll(agent("alice.blog.test"))).response, null);
  } finally {
    console.error = original;
  }
});

test("the connect paths are answered before the toll, on any site", async () => {
  const { calls, fetchImpl } = fakeGate();
  const wellKnown = async (req: Request) => (new URL(req.url).pathname.startsWith("/.well-known/naulon-") ? new Response("challenge") : null);
  const connect = { wellKnown, handle: wellKnown } as never;
  const toll = naulonSites({ gate: "https://gate.test", credentialFor: () => null, fetchImpl, connect });
  assert.equal(await (await toll(agent("new.blog.test", "/.well-known/naulon-challenge/abc"))).response?.text(), "challenge");
  assert.equal((await toll(agent("new.blog.test"))).response, null);
  assert.deepEqual(calls, []);
});

test("a platform gate that is not https is refused at construction", () => {
  assert.throws(() => naulonSites({ gate: "http://gate.example.com", credentialFor: () => null }), /gate must be an https URL/);
});

/** Captures console.error for one call, so a test can say what a misconfigured site was told. */
async function errorsDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return seen;
}

test("one site reads NAULON_KEY and defaults to the hosted gate, like the Python package", async () => {
  const { calls, fetchImpl } = fakeGate();
  const toll = naulonSite({ env: { NAULON_KEY: "nln_site_alice" }, fetchImpl });
  await toll(agent("alice.blog.test"));
  await settle();
  const out = await toll(agent("alice.blog.test"));
  assert.equal(out.response?.status, 402);
  const config = calls.find((c) => c.path === "/_naulon/enforce-config");
  assert.equal(config?.key, "nln_site_alice");
  assert.ok(calls.length > 0);
});

test("NAULON_GATE moves one site to a self-hosted gate, and a code option beats the environment", async () => {
  const seenUrls: string[] = [];
  const { fetchImpl } = fakeGate();
  const spy = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seenUrls.push(new URL(String(input instanceof Request ? input.url : input)).origin);
    return fetchImpl(input, init);
  }) as typeof fetch;
  await naulonSite({ env: { NAULON_KEY: "k", NAULON_GATE: "https://gate.self.test" }, fetchImpl: spy })(agent("alice.blog.test"));
  await naulonSite({ env: { NAULON_KEY: "k", NAULON_GATE: "https://gate.self.test" }, gate: "https://gate.code.test", fetchImpl: spy })(agent("alice.blog.test"));
  await settle();
  assert.ok(seenUrls.includes("https://gate.self.test"));
  assert.ok(seenUrls.includes("https://gate.code.test"));
  assert.equal(seenUrls.some((u) => u === "https://gate.naulon.app"), false);
});

test("no key, a bad env gate, or NAULON_ENABLED=off: nothing is tolled and nothing is asked", async () => {
  for (const env of [{}, { NAULON_KEY: "k", NAULON_GATE: "http://gate.test" }, { NAULON_KEY: "k", NAULON_ENABLED: "off" }, { NAULON_KEY: "k", NAULON_ENABLED: "0" }]) {
    const { calls, fetchImpl } = fakeGate();
    const errors = await errorsDuring(async () => {
      const out = await naulonSite({ env, fetchImpl })(agent("alice.blog.test"));
      assert.equal(out.response, null, JSON.stringify(env));
    });
    assert.deepEqual(calls, [], JSON.stringify(env));
    assert.equal(errors.length, "NAULON_ENABLED" in env ? 0 : 1, `${JSON.stringify(env)} is said once, unless the owner turned it off`);
  }
  assert.throws(() => naulonSite({ env: { NAULON_KEY: "k" }, gate: "http://gate.test" }), /https/, "a gate passed in code is refused loudly");
});

test("on a hostname its credential was not approved for, one site's readers read free", async () => {
  const { fetchImpl } = fakeGate();
  const refusing = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const resource = url.searchParams.get("resource");
    if (resource && new URL(resource).host !== "alice.blog.test") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return fetchImpl(input, init);
  }) as typeof fetch;
  const toll = naulonSite({ env: { NAULON_KEY: "nln_site_alice" }, fetchImpl: refusing });
  await errorsDuring(async () => {
    await toll(agent("www.alice.blog.test"));
    await settle();
    const out = await toll(agent("www.alice.blog.test"));
    assert.notEqual(out.response?.status, 402);
  });
});

test("a site with no key yet still answers its connect paths, or it could never get one", async () => {
  const connect = naulonConnect({ clientName: "My blog" });
  for (const env of [{}, { NAULON_KEY: "k", NAULON_ENABLED: "off" }]) {
    await errorsDuring(async () => {
      const out = await naulonSite({ env, connect })(new Request("https://alice.blog.test/.well-known/naulon-client"));
      assert.equal(out.response?.status, 200, JSON.stringify(env));
      const page = await naulonSite({ env, connect })(agent("alice.blog.test"));
      assert.equal(page.response, null);
    });
  }
});
