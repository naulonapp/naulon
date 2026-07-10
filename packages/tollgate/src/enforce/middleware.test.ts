import { test } from "node:test";
import assert from "node:assert/strict";
import { naulonMiddleware } from "./middleware.ts";
import { localQuoteSource } from "./quote-source.ts";

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

test("human → pass (null, local render)", async () => {
  const mw = naulonMiddleware(opts);
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } }));
  assert.equal(out.response, null);
});

test("non-article → pass (null)", async () => {
  const mw = naulonMiddleware(opts);
  const out = await mw(new Request("http://h/about", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(out.response, null);
});

test("agent, no payment → 402 with PAYMENT-REQUIRED header", async () => {
  const mw = naulonMiddleware(opts);
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(out.response?.status, 402);
  assert.ok(out.response?.headers.get("PAYMENT-REQUIRED"));
});

test("agent + payment, cloud verify ok → pass + PAYMENT-RESPONSE/license on setHeaders", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: true, settlementRef: "0xabc", responseHeader: "rh", licenseJws: "jws" }), {
      status: 200,
    })) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl: fakeFetch });
  const out = await mw(
    new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "payment-signature": "eyJ4Ijp0cnVlfQ==" } }),
  );
  assert.equal(out.response, null);
  assert.equal(out.setHeaders?.["PAYMENT-RESPONSE"], "rh");
  assert.equal(out.setHeaders?.["X-Naulon-License"], "jws");
});

test("agent + payment, cloud verify 402 → 402 passthrough of the error", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: "bad sig" }), { status: 402 })) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl: fakeFetch });
  const out = await mw(
    new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "payment-signature": "eyJ4Ijp0cnVlfQ==" } }),
  );
  assert.equal(out.response?.status, 402);
});
