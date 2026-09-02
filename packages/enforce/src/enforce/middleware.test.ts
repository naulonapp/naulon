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

// ── Audit plane ───────────────────────────────────────────────────────────────
// An in-app site is the only witness to its own traffic. Until it reported, a
// publisher enforcing in their own runtime had an Audit page that could show nothing
// but the decisions the fleet proxy happened to see — i.e. none of theirs.

/** Collect what the middleware reports. */
function reporter() {
  const seen: Array<Record<string, unknown>> = [];
  return { seen, observe: (r: Record<string, unknown>) => void seen.push(r) };
}

const ua = (agent: string, extra: Record<string, string> = {}) => ({ "user-agent": agent, ...extra });

test("a denied agent is reported with the price it walked away from", async () => {
  const { seen, observe } = reporter();
  const mw = naulonMiddleware({ ...opts, observe: observe as never });
  const out = await mw(new Request("http://h/essays/x", { headers: ua("GPTBot/1.0") }));
  assert.equal(out.response?.status, 402);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.verdict, "denied");
  // The slug `decide()` derived (prefix stripped) — byte-identical to what the gate's
  // proxy path writes, so a row from either plane reads the same downstream.
  assert.equal(seen[0]?.slug, "x");
  assert.equal(seen[0]?.classifiedAs, "agent");
  assert.equal(seen[0]?.kind, "read");
  // 5000 whole USDC in this fixture → integer micro on the wire.
  assert.equal(seen[0]?.priceMicro, 5_000_000_000);
  assert.equal((seen[0]?.agent as { ua: string }).ua, "GPTBot/1.0");
});

test("a human read is reported as served-free — the negative space the audit sells", async () => {
  const { seen, observe } = reporter();
  const mw = naulonMiddleware({ ...opts, observe: observe as never });
  await mw(new Request("http://h/essays/x", { headers: ua("Mozilla/5.0 (real browser)") }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.verdict, "served-free");
  assert.equal(seen[0]?.classifiedAs, "human");
});

test("a non-article is NOT reported — an asset request is not traffic on an article", async () => {
  const { seen, observe } = reporter();
  const mw = naulonMiddleware({ ...opts, observe: observe as never });
  await mw(new Request("http://h/about", { headers: ua("GPTBot/1.0") }));
  assert.equal(seen.length, 0);
});

test("a blocked crawler is reported", async () => {
  const { seen, observe } = reporter();
  const mw = naulonMiddleware({
    ...opts,
    publisher: { ...opts.publisher, crawlerPolicy: { block: ["BadBot"] } },
    observe: observe as never,
  });
  const out = await mw(new Request("http://h/essays/x", { headers: ua("BadBot/1.0") }));
  assert.equal(out.response?.status, 403);
  assert.equal(seen[0]?.verdict, "blocked");
});

test("a settled payment is NOT reported here — /verify owns the money verdicts", async () => {
  const { seen, observe } = reporter();
  const fakeFetch = (async () => new Response(JSON.stringify({ ok: true, licenseJws: "jws" }), { status: 200 })) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl: fakeFetch, observe: observe as never });
  const out = await mw(
    new Request("http://h/essays/x", { headers: ua("GPTBot/1.0", { "payment-signature": "eyJ4Ijp0cnVlfQ==" }) }),
  );
  assert.equal(out.response, null);
  assert.equal(seen.length, 0);
});

test("a REFUSED payment is not reported here either — no client asserts its own money", async () => {
  const { seen, observe } = reporter();
  const fakeFetch = (async () => new Response(JSON.stringify({ ok: false, error: "bad sig" }), { status: 402 })) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl: fakeFetch, observe: observe as never });
  const out = await mw(
    new Request("http://h/essays/x", { headers: ua("GPTBot/1.0", { "payment-signature": "eyJ4Ijp0cnVlfQ==" }) }),
  );
  assert.equal(out.response?.status, 402);
  assert.equal(seen.length, 0);
});

test("the /verify body carries the agent block, so the cloud's paid row can attribute it", async () => {
  let sent: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const mw = naulonMiddleware({ ...opts, fetchImpl: fakeFetch });
  await mw(new Request("http://h/essays/x", { headers: ua("GPTBot/1.0", { "payment-signature": "eyJ4Ijp0cnVlfQ==" }) }));
  assert.equal((sent.agent as { ua: string }).ua, "GPTBot/1.0");
  assert.ok((sent.agent as { classifyReason: string }).classifyReason);
  // The settle contract is untouched — the block is additive.
  assert.equal(sent.payment, "eyJ4Ijp0cnVlfQ==");
  assert.equal(sent.resource, "http://h/essays/x");
});

test("without `observe` the middleware behaves exactly as before (no throw, no report)", async () => {
  const mw = naulonMiddleware(opts);
  const out = await mw(new Request("http://h/essays/x", { headers: ua("GPTBot/1.0") }));
  assert.equal(out.response?.status, 402);
});

// ── The control plane owns the policy ────────────────────────────────────────────
// Reproductions of the two failures measured on a live site on 2026-09-02, where the
// dashboard held the policy and the deployed bundle held a literal. There was no test
// here that could have caught either, because the config had no way to arrive at all.

import { staticPublisherConfigSource, httpPublisherConfigSource } from "./config-source.ts";
import { resolvePublisher } from "./middleware.ts";

const SEARCHBOT = "Mozilla/5.0 AppleWebKit/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot";

test("a search indexer reads FREE by default — tolling one deindexes the site", async () => {
  const mw = naulonMiddleware(opts);
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": SEARCHBOT } }));
  assert.equal(out.response, null);
});

test("crawlerPolicy.charge from the CONTROL PLANE tolls that indexer", async () => {
  // The prod bug: this policy sat in the tenant record while the site read a literal, so an
  // indexer the publisher had explicitly set to charge read every article free for weeks.
  const mw = naulonMiddleware({
    ...opts,
    config: staticPublisherConfigSource({
      enforcement: { articlePrefixes: ["essays"], crawlerPolicy: { allow: [], block: [], charge: ["oai-searchbot"] } },
    }),
  });
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": SEARCHBOT } }));
  assert.equal(out.response?.status, 402);
});

test("crawlerPolicy.block from the control plane refuses BEFORE payment", async () => {
  const mw = naulonMiddleware({
    ...opts,
    config: staticPublisherConfigSource({
      enforcement: { articlePrefixes: ["essays"], crawlerPolicy: { allow: [], block: ["badbot"], charge: [] } },
    }),
  });
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "BadBot/1.0" } }));
  assert.equal(out.response?.status, 403);
});

test("gateScope:site from the control plane tolls a path no local prefix covers", async () => {
  // Second prod symptom: the dashboard said whole-site, the bundle said ["articles"], and
  // every other page on the site was free to agents while the operator believed otherwise.
  const mw = naulonMiddleware({
    ...opts,
    config: staticPublisherConfigSource({
      enforcement: { gateScope: { mode: "site", excludePrefixes: ["api"] } },
    }),
  });
  const tolled = await mw(new Request("http://h/about", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(tolled.response?.status, 402, "site mode covers /about");
  const excluded = await mw(new Request("http://h/api/credits/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(excluded.response, null, "excludePrefixes still carves out the publisher's own API");
});

test("the licence issuer is pinned to the config in force, not a literal read at mount", async () => {
  const mw = naulonMiddleware({
    ...opts,
    publisher: { articlePrefixes: ["essays"], licenseIdentity: "naulon:stale.example" },
    config: staticPublisherConfigSource({
      enforcement: { articlePrefixes: ["essays"], licenseIdentity: "naulon:h" },
    }),
    licenseVerification: {},
    fetchImpl: (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as unknown as typeof fetch,
  });
  // A licence is presented; verification cannot succeed against an empty JWKS, so the read
  // falls through to a 402 — the assertion is that this path runs at all without throwing on
  // the mount-time issuer that is no longer true.
  const out = await mw(
    new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0", "X-Naulon-License": "not-a-jws" } }),
  );
  assert.equal(out.response?.status, 402);
});

test("resolvePublisher: remote wins per FIELD, local survives where remote is silent", () => {
  const merged = resolvePublisher(
    { articlePrefixes: ["old"], licenseIdentity: "naulon:local", seoAllowlist: ["bingbot"] },
    { articlePrefixes: ["new"], crawlerPolicy: { allow: [], block: [], charge: ["oai-searchbot"] } },
  ) as Record<string, unknown>;
  assert.deepEqual(merged["articlePrefixes"], ["new"]);
  assert.deepEqual(merged["seoAllowlist"], ["bingbot"], "a field the tenant never set keeps the local floor");
  assert.equal(merged["licenseIdentity"], "naulon:local");
  assert.ok(merged["crawlerPolicy"]);
});

test("resolvePublisher: neither source ⇒ undefined (the caller passes through)", () => {
  assert.equal(resolvePublisher(undefined, undefined), undefined);
  assert.equal(resolvePublisher(undefined, {}), undefined);
});

test("a control plane that cannot be reached passes the request through — never a 500", async () => {
  const mw = naulonMiddleware({
    quote,
    verifyUrl: opts.verifyUrl,
    apiKey: opts.apiKey,
    config: httpPublisherConfigSource("http://cloud/c", "k", {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      onFailure: () => {},
    }),
  });
  const out = await mw(new Request("http://h/essays/x", { headers: { "user-agent": "GPTBot/1.0" } }));
  assert.equal(out.response, null, "a lookup failure on our side must not break their site");
});
