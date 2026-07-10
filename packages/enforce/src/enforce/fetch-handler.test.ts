import { test } from "node:test";
import assert from "node:assert/strict";
import { withNaulon } from "./fetch-handler.ts";
import { localQuoteSource } from "./quote-source.ts";

const article = () => new Response("article body", { status: 200, headers: { "content-type": "text/plain" } });

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

test("human → handler runs, article served", async () => {
  const wrapped = withNaulon(article, opts);
  const res = await wrapped(new Request("http://h/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "article body");
});

test("agent, no payment → 402, handler NEVER runs", async () => {
  let ran = false;
  const wrapped = withNaulon(() => { ran = true; return article(); }, opts);
  const res = await wrapped(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(res.status, 402);
  assert.equal(ran, false);
});

test("agent + payment ok → handler runs, PAYMENT-RESPONSE stamped on its response", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ ok: true, responseHeader: "rh", licenseJws: "jws" }), { status: 200 })) as unknown as typeof fetch;
  const wrapped = withNaulon(article, { ...opts, fetchImpl: fakeFetch });
  const res = await wrapped(
    new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "payment-signature": "eyJ4Ijp0cnVlfQ==" } }),
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "article body");
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), "rh");
  assert.equal(res.headers.get("X-Naulon-License"), "jws");
});
