import { test } from "node:test";
import assert from "node:assert/strict";
import { createNaulonMiddleware } from "./next.ts";
import { localQuoteSource } from "./quote-source.ts";

// A stand-in for `next/server`'s NextResponse: `.next()` returns a tagged Response
// (a real NextResponse extends Response; the adapter only touches `.next()` + headers).
const NextResponse = {
  next(): Response {
    return new Response(null, { status: 200, headers: { "x-mw": "next" } });
  },
};

const quote = localQuoteSource(async () =>
  ({
    slug: "essays/x",
    kind: "read",
    title: "X",
    price: 5000,
    payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
    extraLegs: [],
    coauthorSplit: false,
  }) as never,
);

const opts = {
  publisher: { id: "p", articlePrefixes: ["essays"], licenseIdentity: "did:web:t", seoAllowlist: [] },
  quote,
  verifyUrl: "http://cloud/_naulon/verify",
  apiKey: "nln_live_test",
};

test("human → NextResponse.next() (pass to route)", async () => {
  const mw = createNaulonMiddleware(opts, NextResponse);
  const res = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-mw"), "next"); // came from NextResponse.next()
});

test("agent, no payment → 402 short-circuit (not next())", async () => {
  const mw = createNaulonMiddleware(opts, NextResponse);
  const res = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(res.status, 402);
  assert.ok(res.headers.get("PAYMENT-REQUIRED"));
  assert.equal(res.headers.get("x-mw"), null); // did NOT go through next()
});

test("agent + payment ok → next() carrying the paid receipt headers", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: true, responseHeader: "rh", licenseJws: "jws" }), { status: 200 })) as unknown as typeof fetch;
  const mw = createNaulonMiddleware({ ...opts, fetchImpl: fakeFetch }, NextResponse);
  const res = await mw(
    new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "payment-signature": "eyJ4Ijp0cnVlfQ==" } }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), "rh");
  assert.equal(res.headers.get("X-Naulon-License"), "jws");
});
