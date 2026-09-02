import { test } from "node:test";
import assert from "node:assert/strict";
import {
  httpPublisherConfigSource,
  serveX402Manifest,
  staticPublisherConfigSource,
  type ConfigLookupFailure,
} from "./config-source.ts";

const RESOURCE = "https://site.test/articles/x";

/** A control plane that answers with `body`, counting calls. */
function planeReturning(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const DOC = {
  enforcement: {
    articlePrefixes: ["articles"],
    gateScope: { mode: "site", excludePrefixes: ["api"] },
    licenseIdentity: "naulon:site.test",
    seoAllowlist: ["googlebot"],
    crawlerPolicy: { allow: ["googlebot"], block: ["badbot"], charge: ["oai-searchbot"] },
  },
  manifest: { x402Version: 2, humansReadFree: true },
};

test("loads the document and carries every field decide() reads", async () => {
  const { fetchImpl, calls } = planeReturning(DOC);
  const src = httpPublisherConfigSource("http://cloud/_naulon/enforce-config", "nln_live_k", { fetchImpl });
  const doc = await src.load({ resource: RESOURCE });
  assert.deepEqual(doc?.enforcement.crawlerPolicy, DOC.enforcement.crawlerPolicy);
  assert.deepEqual(doc?.enforcement.gateScope, DOC.enforcement.gateScope);
  assert.equal(doc?.enforcement.licenseIdentity, "naulon:site.test");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes(encodeURIComponent(RESOURCE)), "the host being decided selects the config");
});

test("a field this SDK does not know is DISCARDED, not spread onto the publisher", async () => {
  // The control plane ships independently of the publisher's bundle, so it will one day
  // serve a key this version has never heard of. Anything fleet-only that leaked through
  // here would end up inside a publisher's request handler by accident.
  const { fetchImpl } = planeReturning({
    enforcement: { ...DOC.enforcement, originAuthSecret: "s3cret", credits: { url: "x" } },
  });
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl });
  const doc = await src.load({ resource: RESOURCE });
  assert.ok(doc);
  assert.deepEqual(
    Object.keys(doc.enforcement).sort(),
    ["articlePrefixes", "crawlerPolicy", "gateScope", "licenseIdentity", "seoAllowlist"],
    "exactly the five decide() inputs survive the narrow",
  );
  assert.ok(!JSON.stringify(doc).includes("s3cret"));
});

test("an absent field is omitted, never carried as undefined", async () => {
  // A spread of `{crawlerPolicy: undefined}` blanks a local default. The narrow must strip
  // it so a partial document degrades to "no opinion", not "explicitly nothing".
  const { fetchImpl } = planeReturning({ enforcement: { articlePrefixes: ["articles"] } });
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl });
  const doc = await src.load({ resource: RESOURCE });
  assert.deepEqual(Object.keys(doc?.enforcement ?? {}), ["articlePrefixes"]);
});

test("cached inside the TTL — a live site does not fetch its own config per page view", async () => {
  const { fetchImpl, calls } = planeReturning(DOC);
  let t = 1_000;
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl, now: () => t, ttlMs: 60_000 });
  for (let i = 0; i < 25; i++) await src.load({ resource: RESOURCE });
  assert.equal(calls.length, 1);
  t += 60_001;
  await src.load({ resource: RESOURCE });
  assert.equal(calls.length, 2, "refetched once the TTL lapsed");
});

test("concurrent cold loads share ONE fetch (no stampede on a cold start)", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(DOC), { status: 200 });
  }) as unknown as typeof fetch;
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl });
  const docs = await Promise.all(Array.from({ length: 12 }, () => src.load({ resource: RESOURCE })));
  assert.equal(calls, 1);
  assert.ok(docs.every((d) => d?.enforcement.licenseIdentity === "naulon:site.test"));
});

test("each host is cached separately (one runtime may serve several)", async () => {
  const { fetchImpl, calls } = planeReturning(DOC);
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl });
  await src.load({ resource: "https://a.test/articles/x" });
  await src.load({ resource: "https://b.test/articles/x" });
  await src.load({ resource: "https://a.test/articles/y" });
  assert.equal(calls.length, 2);
});

test("stale-if-error: a failing refresh keeps the last known-good config and SAYS so", async () => {
  let ok = true;
  const fetchImpl = (async () =>
    ok ? new Response(JSON.stringify(DOC), { status: 200 }) : new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const failures: ConfigLookupFailure[] = [];
  let t = 0;
  const src = httpPublisherConfigSource("http://cloud/c", "k", {
    fetchImpl,
    now: () => t,
    ttlMs: 1_000,
    onFailure: (f) => failures.push(f),
  });
  assert.ok(await src.load({ resource: RESOURCE }));
  ok = false;
  t += 2_000;
  const doc = await src.load({ resource: RESOURCE });
  assert.equal(doc?.enforcement.licenseIdentity, "naulon:site.test", "the toll does not switch off on a blip");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.servingStale, true);
  assert.equal(failures[0]?.status, 500);
});

test("a COLD failure returns null and reports the loud variant", async () => {
  const { fetchImpl } = planeReturning({}, 401);
  const failures: ConfigLookupFailure[] = [];
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl, onFailure: (f) => failures.push(f) });
  assert.equal(await src.load({ resource: RESOURCE }), null);
  assert.equal(failures[0]?.servingStale, false, "nothing is in scope — this is the revenue-stop shape");
  assert.equal(failures[0]?.host, "site.test");
});

test("a failing lookup is not retried per request (a dead key must not become a flood)", async () => {
  const { fetchImpl, calls } = planeReturning({}, 401);
  let t = 0;
  const src = httpPublisherConfigSource("http://cloud/c", "k", {
    fetchImpl,
    now: () => t,
    retryAfterMs: 30_000,
    onFailure: () => {},
  });
  for (let i = 0; i < 50; i++) await src.load({ resource: RESOURCE });
  assert.equal(calls.length, 1);
  t += 30_001;
  await src.load({ resource: RESOURCE });
  assert.equal(calls.length, 2);
});

test("an unreachable control plane resolves, never throws (a 500 on THEIR site is worse)", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const failures: ConfigLookupFailure[] = [];
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl, onFailure: (f) => failures.push(f) });
  assert.equal(await src.load({ resource: RESOURCE }), null);
  assert.equal(failures[0]?.status, 0);
});

test("a 200 whose body is not a config is a broken plane, not an empty policy", async () => {
  const fetchImpl = (async () => new Response("<html>maintenance</html>", { status: 200 })) as unknown as typeof fetch;
  const failures: ConfigLookupFailure[] = [];
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl, onFailure: (f) => failures.push(f) });
  assert.equal(await src.load({ resource: RESOURCE }), null);
  assert.equal(failures.length, 1);
});

test("an unparseable resource never reaches the network", async () => {
  const { fetchImpl, calls } = planeReturning(DOC);
  const src = httpPublisherConfigSource("http://cloud/c", "k", { fetchImpl });
  assert.equal(await src.load({ resource: "not a url" }), null);
  assert.equal(calls.length, 0);
});

test("serveX402Manifest answers the path every 402's Link header advertises", async () => {
  const h = serveX402Manifest(staticPublisherConfigSource(DOC as never));
  const res = await h(new Request("https://site.test/.well-known/x402"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), DOC.manifest);
});

test("no manifest → 404, never a locally-invented one", async () => {
  // An in-app runtime holds no price and no network. Anything it synthesised here would be
  // a guess published as terms.
  const h = serveX402Manifest(staticPublisherConfigSource({ enforcement: {} }));
  assert.equal((await h(new Request("https://site.test/.well-known/x402"))).status, 404);
});
