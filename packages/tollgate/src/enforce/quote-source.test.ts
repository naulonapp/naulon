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
