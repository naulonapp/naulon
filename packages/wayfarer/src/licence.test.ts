import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher } from "@naulon/sdk/crawl";
import { makeLicenceResolver } from "./licence.ts";

const DOC = (price: string, extra = "") => `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/"${extra}><license><permits type="usage">ai-input</permits>
  <payment type="crawl"><amount currency="USD">${price}</amount>
  <accepts type="application/x402+json"/></payment></license></content></rsl>`;

function fakeNet(routes: Record<string, { status?: number; body?: string }>) {
  const asked: string[] = [];
  const fetcherFor = (_origin: string): Fetcher => async (url) => {
    asked.push(url);
    const r = routes[url];
    const status = r ? (r.status ?? 200) : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return r?.body ?? ""; },
      async json() { return null; },
    };
  };
  return { fetcherFor, asked };
}

const ROBOTS_SITE = {
  "https://pub.example/robots.txt": { body: "User-agent: *\nLicense: https://pub.example/license.xml" },
  "https://pub.example/license.xml": { body: DOC("0.01") },
};

test("terms resolve from the origin's robots licence", async () => {
  const net = fakeNet(ROBOTS_SITE);
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const got = await r.forUrl("https://pub.example/articles/x");
  assert.equal(got.source, "robots");
  assert.equal(got.terms?.usage["ai-input"], true);
  assert.deepEqual(got.terms?.read?.amount, { value: 0.01, currency: "USD" });
});

test("one origin is fetched ONCE for many candidates, and concurrently too", async () => {
  const net = fakeNet(ROBOTS_SITE);
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  // Concurrent: the in-flight dedupe is what stops ten candidates becoming ten robots fetches on
  // a stranger's server.
  await Promise.all([1, 2, 3, 4, 5].map((n) => r.forUrl(`https://pub.example/a/${n}`)));
  await r.forUrl("https://pub.example/a/6"); // and again, from the cache
  assert.equal(net.asked.filter((u) => u.endsWith("/robots.txt")).length, 1);
  assert.equal(net.asked.filter((u) => u.endsWith("/license.xml")).length, 1);
  assert.equal(r.originsSeen(), 1);
});

test("the NEGATIVE answer is cached too — it is the common one and the costly one to re-learn", async () => {
  const net = fakeNet({ "https://bare.example/robots.txt": { body: "User-agent: *\nDisallow:" } });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  assert.equal((await r.forUrl("https://bare.example/a")).terms, null);
  assert.equal((await r.forUrl("https://bare.example/b")).terms, null);
  assert.equal(net.asked.length, 1);
});

test("a failed lookup is NOT cached as 'no licence' — a timeout is a fact about the network", async () => {
  let calls = 0;
  const flaky = (): Fetcher => async (url) => {
    calls += 1;
    if (calls === 1) throw new Error("ETIMEDOUT");
    return {
      ok: true,
      status: 200,
      async text() {
        return url.endsWith("robots.txt") ? "License: https://pub.example/license.xml" : DOC("0.02");
      },
      async json() { return null; },
    };
  };
  const r = makeLicenceResolver({ fetcherFor: flaky });
  assert.equal((await r.forUrl("https://pub.example/a")).terms, null, "first attempt fails");
  const second = await r.forUrl("https://pub.example/b");
  assert.equal(second.terms?.read?.amount?.value, 0.02, "the retry is allowed to succeed");
});

test("a page-level licence wins over the origin's, and is not cached against the origin", async () => {
  const net = fakeNet({
    ...ROBOTS_SITE,
    "https://pub.example/page.xml": { body: DOC("0.99") },
  });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const observed = { headers: { link: '</page.xml>; rel="license"; type="application/rsl+xml"' } };
  const page = await r.forUrl("https://pub.example/priced", observed);
  assert.equal(page.source, "link-header");
  assert.equal(page.terms?.read?.amount?.value, 0.99);
  assert.equal(r.originsSeen(), 0, "a per-url answer must never become the whole site's");

  // A different url on the same origin still gets the site-wide terms.
  const other = await r.forUrl("https://pub.example/other");
  assert.equal(other.source, "robots");
  assert.equal(other.terms?.read?.amount?.value, 0.01);
});

test("terms expire, so a publisher who changes their price is not quoted the old one forever", async () => {
  let body = DOC("0.01");
  const fetcherFor = (): Fetcher => async (url) => ({
    ok: true,
    status: 200,
    async text() { return url.endsWith("robots.txt") ? "License: https://pub.example/license.xml" : body; },
    async json() { return null; },
  });
  const r = makeLicenceResolver({ fetcherFor, ttlMs: 0 });
  assert.equal((await r.forUrl("https://pub.example/a")).terms?.read?.amount?.value, 0.01);
  body = DOC("0.05");
  assert.equal((await r.forUrl("https://pub.example/a")).terms?.read?.amount?.value, 0.05);
});

test("a document that governs the origin but not this url reads as no terms", async () => {
  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "License: https://pub.example/l.xml" },
    "https://pub.example/l.xml": {
      body: `<rsl xmlns="https://rslstandard.org/rsl"><content url="/articles/*">
        <license><permits type="usage">ai-input</permits></license></content></rsl>`,
    },
  });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  assert.equal((await r.forUrl("https://pub.example/about")).terms, null);
  assert.notEqual((await r.forUrl("https://pub.example/articles/x")).terms, null);
});

test("a malformed url resolves to no terms without touching the network", async () => {
  const net = fakeNet({});
  assert.equal((await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("nope")).terms, null);
  assert.equal(net.asked.length, 0);
});
