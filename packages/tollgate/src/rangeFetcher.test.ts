import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIp } from "@naulon/shared";
import { createRangeFetcher } from "./rangeFetcher.ts";

const json = (prefixes: string[]) =>
  JSON.stringify({ creationTime: "x", prefixes: prefixes.map((p) => (p.includes(":") ? { ipv6Prefix: p } : { ipv4Prefix: p })) });
const GOOGLE = "https://developers.google.com/static/crawling/ipranges/common-crawlers.json";

const CF4 = "https://www.cloudflare.com/ips-v4";
const CF6 = "https://www.cloudflare.com/ips-v6";
/** Cloudflare's lists answer unless a test removes them: the gate publishes nothing without them. */
const PROXIES: Record<string, () => Response> = {
  [CF4]: () => new Response("173.245.48.0/20\n103.21.244.0/22\n"),
  [CF6]: () => new Response("2400:cb00::/32\n"),
};

function fakeFetch(routes: Record<string, () => Response>, calls: string[] = [], proxies = true): typeof fetch {
  const all = proxies ? { ...PROXIES, ...routes } : routes;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = all[url];
    if (!r) return new Response("nope", { status: 404 });
    return r();
  }) as typeof fetch;
}

test("cold start: current() is null and starts one refresh; after it, Google verifies", async () => {
  const calls: string[] = [];
  const f = createRangeFetcher({ fetchImpl: fakeFetch({ [GOOGLE]: () => new Response(json(["66.249.64.0/27"])) }, calls) });
  assert.equal(f.current(), null);
  assert.equal(f.current(), null);
  await f.refresh();
  const c = f.current()!;
  assert.equal(c.operators.get("google")!.set.has(parseIp("66.249.64.9")!), true);
  assert.equal(calls.filter((u) => u === GOOGLE).length, 1); // single-flight: the awaited refresh joins the background one
});

test("a redirect is followed and reported in the document's sources", async () => {
  const OLD = GOOGLE.replace("crawling/ipranges/common-crawlers", "search/apis/ipranges/googlebot");
  const f = createRangeFetcher({
    fetchImpl: fakeFetch({
      [GOOGLE]: () => new Response(null, { status: 301, headers: { location: OLD } }),
      [OLD]: () => new Response(json(["66.249.64.0/27"])),
    }),
  });
  await f.refresh();
  const src = f.document()!.sources.find((s) => s.url === GOOGLE)!;
  assert.equal(src.status, "redirected");
  assert.equal(src.finalUrl, OLD);
  assert.equal(f.document()!.operators.find((o) => o.id === "google")!.prefixes.length, 1);
});

test("more than 3 redirects, an oversize body and HTML are refused", async () => {
  const loop = () => new Response(null, { status: 302, headers: { location: GOOGLE } });
  const f1 = createRangeFetcher({ fetchImpl: fakeFetch({ [GOOGLE]: loop }) });
  await f1.refresh();
  assert.equal(f1.document()!.sources.find((s) => s.url === GOOGLE)!.status, "unreachable");

  const big = json(Array.from({ length: 50 }, (_, i) => `66.249.${i}.0/24`));
  const f2 = createRangeFetcher({ maxBytes: 100, fetchImpl: fakeFetch({ [GOOGLE]: () => new Response(big) }) });
  await f2.refresh();
  assert.equal(f2.document()!.sources.find((s) => s.url === GOOGLE)!.status, "bad-shape");

  const f3 = createRangeFetcher({ fetchImpl: fakeFetch({ [GOOGLE]: () => new Response("<!doctype html>") }) });
  await f3.refresh();
  assert.equal(f3.document()!.sources.find((s) => s.url === GOOGLE)!.status, "bad-shape");
});

test("non-ranges operators are in the document with no prefixes, so other runtimes learn every fragment", async () => {
  const f = createRangeFetcher({ fetchImpl: fakeFetch({}) });
  await f.refresh();
  const meta = f.document()!.operators.find((o) => o.id === "meta")!;
  assert.deepEqual(meta.prefixes, []);
  assert.equal(meta.kind, "none");
});

test("disabled: never fetches, current() stays null", async () => {
  const calls: string[] = [];
  const f = createRangeFetcher({ disabled: true, fetchImpl: fakeFetch({}, calls) });
  assert.equal(f.current(), null);
  await f.refresh();
  assert.equal(calls.length, 0);
});

test("refreshes again only after refreshMs", async () => {
  const calls: string[] = [];
  let t = 0;
  const f = createRangeFetcher({ now: () => t, refreshMs: 1000, fetchImpl: fakeFetch({ [GOOGLE]: () => new Response(json(["66.249.64.0/27"])) }, calls) });
  await f.refresh();
  const n = calls.length;
  f.current();
  assert.equal(calls.length, n);
  t = 1001;
  f.current();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.length > n);
});

test("I3: a source with no good copy yet is retried after 5 minutes, not 6 hours", async () => {
  const calls: string[] = [];
  let t = 0;
  let up = false;
  const f = createRangeFetcher({
    now: () => t,
    fetchImpl: fakeFetch({ [GOOGLE]: () => (up ? new Response(json(["66.249.64.0/27"])) : new Response("down", { status: 503 })) }, calls),
  });
  await f.refresh();
  const n = calls.filter((u) => u === GOOGLE).length;
  t = 4 * 60_000;
  f.current();
  assert.equal(calls.filter((u) => u === GOOGLE).length, n);
  up = true;
  t = 5 * 60_000 + 1;
  f.current();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(f.current()?.operators.get("google")!.set.size);
});

test("M2: a redirect to plain http is refused", async () => {
  const f = createRangeFetcher({
    fetchImpl: fakeFetch({ [GOOGLE]: () => new Response(null, { status: 301, headers: { location: "http://developers.google.com/x.json" } }) }),
  });
  await f.refresh();
  const src = f.document()!.sources.find((s) => s.url === GOOGLE)!;
  assert.equal(src.status, "unreachable");
  assert.match(src.detail ?? "", /https/);
});

test("I2: no document until every proxy list has had a good copy, so a proxy's address can never read as a caller's", async () => {
  let cfUp = false;
  const f = createRangeFetcher({
    fetchImpl: fakeFetch(
      { [GOOGLE]: () => new Response(json(["66.249.64.0/27"])), [CF4]: () => (cfUp ? PROXIES[CF4]!() : new Response("down", { status: 503 })), [CF6]: () => PROXIES[CF6]!() },
      [],
      false,
    ),
  });
  await f.refresh();
  assert.equal(f.document(), null);
  assert.equal(f.current(), null);
  cfUp = true;
  await f.refresh();
  assert.ok(f.document()!.proxies.cloudflare!.includes("173.245.48.0/20"));
});

test("I3: a redirect to a target the URL parser refuses fails that source alone", async () => {
  const f = createRangeFetcher({
    fetchImpl: fakeFetch({ [GOOGLE]: () => new Response(null, { status: 301, headers: { location: "https://a b/" } }) }),
  });
  await f.refresh();
  const src = f.document()!.sources.find((s) => s.url === GOOGLE)!;
  assert.equal(src.status, "unreachable");
  assert.ok(f.document()!.proxies.cloudflare!.length > 0);
});

test("M7: a retry refetches only the sources that never succeeded", async () => {
  const calls: string[] = [];
  let t = 0;
  const f = createRangeFetcher({ now: () => t, fetchImpl: fakeFetch({ [GOOGLE]: () => new Response("down", { status: 503 }) }, calls) });
  await f.refresh();
  const cfBefore = calls.filter((u) => u === CF4).length;
  const googleBefore = calls.filter((u) => u === GOOGLE).length;
  t = 5 * 60_000 + 1;
  f.current();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((u) => u === CF4).length, cfBefore);
  assert.ok(calls.filter((u) => u === GOOGLE).length > googleBefore);
});
