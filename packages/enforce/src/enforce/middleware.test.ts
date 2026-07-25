import { test } from "node:test";
import assert from "node:assert/strict";
import { naulonMiddleware } from "./middleware.ts";
import { localQuoteSource, httpQuoteSource } from "./quote-source.ts";

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

test("cloud QuoteSource: agent no-pay → 402 built from the fetched /quote", async () => {
  const quoteFetch = (async () =>
    new Response(
      JSON.stringify({
        slug: "essays/x",
        kind: "read",
        title: "X",
        price: 5000,
        payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
        extraLegs: [],
        coauthorSplit: false,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, quote: httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", quoteFetch) });
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(out.response?.status, 402);
  assert.ok(out.response?.headers.get("PAYMENT-REQUIRED"));
});

test("cloud QuoteSource: 204 (no toll) → pass (free)", async () => {
  const quoteFetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, quote: httpQuoteSource("http://cloud/_naulon/quote", "nln_live_test", quoteFetch) });
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(out.response, null);
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

// ── API-mode license verification: fetch the gate JWKS + free re-read ────────────
// MCP-HELD-1: in API mode the license is gate-signed, so the middleware must verify a
// re-read against the gate's published JWKS. Enabling `licenseVerification` makes the
// middleware fetch /.well-known/naulon-jwks.json (cached) and pass it into decide().
import { jwksOf, loadSigningKey, mintLicense } from "@naulon/shared";

const GATE_KEY = loadSigningKey();
const GATE_JWKS = jwksOf([GATE_KEY]);
const ISS = "did:web:t"; // must equal publisher.licenseIdentity (the gate's stamp)

function mintFor(slug: string): string {
  const at = Date.now();
  const event = {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    slug, kind: "citation", amount: 0.003,
    payees: [{ authorId: "a", wallet: `0x${"1".repeat(40)}`, share: 1 }],
    payerAddress: `0x${"3".repeat(40)}`, settlementRef: "0xref", at,
  } as any;
  return mintLicense(
    { event, issuer: ISS, audience: ISS, ttlSeconds: 3600, payeesMode: "full", title: "X", network: "eip155:5042002" as any } as any,
    GATE_KEY, at,
  );
}

test("API mode: middleware fetches the gate JWKS and a gate-minted license re-reads free (pass, null)", async () => {
  let jwksHits = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/.well-known/naulon-jwks.json")) {
      jwksHits++;
      return new Response(JSON.stringify(GATE_JWKS), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as unknown as typeof fetch;

  const mw = naulonMiddleware({ ...opts, fetchImpl, licenseVerification: {} });
  const reread = () =>
    mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "X-Naulon-License": mintFor("x") } }));

  const out = await reread();
  assert.equal(out.response, null, "a gate-minted license is a free re-read (pass), not a 402");
  assert.equal(jwksHits, 1, "the gate JWKS was fetched from the well-known endpoint");

  // Second re-read reuses the cached JWKS (no refetch within the TTL).
  await reread();
  assert.equal(jwksHits, 1, "the JWKS is cached — no per-request refetch");
});

test("API mode: the hot path (no license header) never fetches the JWKS", async () => {
  let jwksHits = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("naulon-jwks.json")) jwksHits++;
    return new Response(JSON.stringify(GATE_JWKS), { status: 200 });
  }) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl, licenseVerification: {} });
  // A human read and a first-time agent 402 carry no license → no JWKS fetch.
  await mw(new Request("http://h/essays/x", { headers: { "user-agent": "Mozilla/5.0 (real browser)" } }));
  await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(jwksHits, 0, "no license presented ⇒ the JWKS is never fetched on the hot path");
});
