import { test } from "node:test";
import assert from "node:assert/strict";
import { localQuoteSource, httpQuoteSource } from "./quote-source.ts";

const aQuote = {
  slug: "essays/x",
  kind: "read",
  title: "X",
  price: 5000,
  payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
  extraLegs: [],
  coauthorSplit: false,
} as never;

const ctx = { resource: "http://h/essays/x" };

test("localQuoteSource maps undefined → null (free read)", async () => {
  const qs = localQuoteSource(async () => undefined);
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
});

test("localQuoteSource passes a real quote through", async () => {
  const qs = localQuoteSource(async () => aQuote);
  const q = await qs.quote({}, "essays/x", "read", ctx);
  assert.equal((q as { slug: string })?.slug, "essays/x");
});

test("httpQuoteSource: 204 → null (no toll)", async () => {
  const fakeFetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch);
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
});

test("httpQuoteSource: 200 → the quote, bearer-authed, resource in query", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = (init.headers as Record<string, string>).authorization ?? "";
    return new Response(JSON.stringify(aQuote), { status: 200 });
  }) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch);
  const q = await qs.quote({}, "essays/x", "read", ctx);
  assert.equal((q as { slug: string })?.slug, "essays/x");
  assert.match(seenUrl, /resource=http/);
  assert.equal(seenAuth, "Bearer nln_live_test");
});

test("httpQuoteSource: non-ok (500) fails open → null (never gate a reader)", async () => {
  const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch);
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
});

// Failing open is invisible by construction: the origin answers 200, the reader is happy, and the
// money quietly stops. Prod, 2026-08-04 — a publisher's key stopped resolving (its tenant had been
// closed and recreated) and every priced article was served free for a day, with nothing in either
// runtime saying so. Every failure now reports; a 204 (the deliberate don't-gate signal) never does.
test("httpQuoteSource: a REJECTED key fails open AND reports it", async () => {
  const seen: { status: number; resource: string; reason: string }[] = [];
  const fakeFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_dead", fakeFetch, (f) => seen.push(f));
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null, "a reader is never blocked by our outage");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.status, 401);
  assert.equal(seen[0]?.resource, "http://h/essays/x", "the report names the resource whose toll just stopped");
});

// The worse half of the same bug: an unreachable control plane used to THROW out of quote(), through
// decide(), and out of the publisher's middleware — turning our outage into a 500 on their site, for
// humans included. Fail open, report, never propagate.
test("httpQuoteSource: an unreachable control plane fails open instead of throwing", async () => {
  const seen: { status: number; reason: string }[] = [];
  const fakeFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch, (f) => seen.push(f));
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
  assert.equal(seen[0]?.status, 0, "no response at all");
  assert.match(seen[0]?.reason ?? "", /ECONNREFUSED/);
});

test("httpQuoteSource: a 200 that is not a Quote is a broken plane, not a free article", async () => {
  const seen: unknown[] = [];
  const fakeFetch = (async () => new Response("<html>gateway error</html>", { status: 200 })) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch, (f) => seen.push(f));
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
  assert.equal(seen.length, 1);
});

test("httpQuoteSource: a 204 is NOT reported — it is the deliberate don't-gate signal", async () => {
  const seen: unknown[] = [];
  const fakeFetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const qs = httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", fakeFetch, (f) => seen.push(f));
  assert.equal(await qs.quote({}, "essays/x", "read", ctx), null);
  assert.deepEqual(seen, []);
});
