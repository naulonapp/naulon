// A runtime serves the page when the gate gives no verdict (docs/protocol/in-app.md, rule 4). So no
// input a buyer controls may produce a 5xx on any enforce route, and on the two routes that answer
// with a verdict, every answer the gate writes about the request must carry one. If either failed,
// that payment or licence would read free on demand.
//
// Generated, not hand-picked: a seeded generator drives every route with mixed well-formed and
// hostile values, and the real settle and licence check run unstubbed. A failure prints the seed
// and the input, so it replays exactly.
process.env.PAYMENT_MODE = "mock";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { build402 } from "@naulon/enforce";
import { gateVerdictOf } from "@naulon/shared";
import { mountFromHostedDeps } from "./hostedDeps.testkit.ts";

const SEED = Number(process.env.PROPERTY_SEED ?? 20261103);
const RUNS = Number(process.env.PROPERTY_RUNS ?? 300);

/** mulberry32: small, seedable, good enough to spread inputs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const RESOURCE = "http://h.test/essays/x";
const QUOTE = {
  slug: "essays/x",
  title: "x",
  kind: "read",
  price: 0.001,
  payees: [{ authorId: "a", wallet: `0x${"1".repeat(40)}`, share: 1 }],
  extraLegs: [],
};

/** Strings an agent can put in a header or a payload: encodings, control bytes, sizes, near-misses. */
const NASTY_STRINGS = [
  "",
  " ",
  "€",
  "a\nb",
  "a\u0000b",
  "\ud800",
  "%00",
  "!!!not-base64!!!",
  "x",
  "a.b.c",
  "..",
  "a.b.c.d.e",
  "0x",
  `0x${"z".repeat(40)}`,
  "NaN",
  "-1",
  "1e309",
  "9".repeat(400),
  "e".repeat(100_000),
  "http://",
  "http://h.test",
  "http://other.test/essays/x",
  "javascript:alert(1)",
  RESOURCE,
  "essays/x",
  "read",
  "citation",
  b64("null"),
  b64("[]"),
  b64("[null,null]"),
  b64("1"),
  b64('"x"'),
  b64("{}"),
  b64('{"payload":null}'),
  b64('{"payload":{"authorization":null,"signature":7}}'),
  b64(JSON.stringify({ x402Version: 2, payload: { authorization: { from: 1, value: {} } } })),
  b64(JSON.stringify({ payer: "0xp", amount: "abc", nonce: "n" })),
  b64(JSON.stringify({ payer: "0xp", amount: 7, nonce: "n" })),
  `${b64("{}")}.${b64("null")}.sig`,
  `${b64('{"alg":"none"}')}.${b64("{}")}.`,
];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

/** Any JSON value, nested to a small depth. */
function anyValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * (depth > 2 ? 5 : 8));
  switch (k) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return pick(r, [0, -1, 1.5, 1e308, -0, Number.MAX_SAFE_INTEGER + 2]);
    case 3:
    case 4: return pick(r, NASTY_STRINGS);
    case 5: return Array.from({ length: Math.floor(r() * 4) }, () => anyValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(r() * 4); i++) o[pick(r, ["requirements", "payTo", "amount", "price", "slug", "kind", "x", "__proto__"])] = anyValue(r, depth + 1);
      return o;
    }
  }
}

/** Mostly the well-formed value, so inputs reach deep into the route; otherwise anything. */
function field(r: () => number, good: unknown): unknown {
  return r() < 0.7 ? good : anyValue(r);
}

function app(): OpenAPIHono {
  const a = new OpenAPIHono();
  const publisher = {
    id: "pub_a",
    suspended: false,
    originUrl: "http://o",
    articlePrefixes: ["essays"],
    licenseIdentity: "did:web:t",
    price: 1000,
    citationMultiplier: 2,
    credits: { resolve: async (slug: string) => (slug === "essays/x" ? { slug, title: "x", contributors: [{ id: "a", wallet: `0x${"1".repeat(40)}`, share: 1 }] } : undefined) },
  };
  mountFromHostedDeps(a, {
    resolver: { resolve: async () => publisher } as never,
    apiKeyResolve: async () => ({ tenantId: "pub_a" }),
  });
  return a;
}

const keyed = { authorization: "Bearer k", "content-type": "application/json" };

function rawBody(r: () => number, value: unknown): string {
  const roll = r();
  if (roll < 0.05) return pick(r, ["", "{", "[", "null", "not json", "\u0000"]);
  return JSON.stringify(value);
}

async function send(a: OpenAPIHono, path: string, init: RequestInit): Promise<{ status: number; body: unknown; text: string }> {
  const res = await a.request(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the assertions below say what that means for each route.
  }
  return { status: res.status, body, text };
}

const describe = (seed: number, i: number, input: unknown) =>
  `seed ${seed} run ${i}: ${String(input).slice(0, 300)}`;

test("no generated input makes /verify answer 5xx, and every answer carries a verdict", async () => {
  const r = rng(SEED);
  const a = app();
  const legs = build402(QUOTE as never, RESOURCE, Date.now()).legs;
  let reachedSettle = 0;
  for (let i = 0; i < RUNS; i++) {
    const input = {
      payment: field(r, pick(r, NASTY_STRINGS) || "x"),
      legs: field(r, legs),
      quote: field(r, QUOTE),
      resource: field(r, RESOURCE),
      agent: field(r, { ua: pick(r, NASTY_STRINGS) }),
    };
    const raw = rawBody(r, input);
    const out = await send(a, "/_naulon/verify", { method: "POST", headers: keyed, body: raw });
    assert.ok(out.status < 500, `${describe(SEED, i, raw)} answered ${out.status} ${out.text.slice(0, 200)}`);
    // 403 is the host refusal (a generated resource on another host), the only answer that may omit it.
    if (out.status !== 403) assert.notEqual(gateVerdictOf(out.body), null, `${describe(SEED, i, raw)} answered ${out.status} with no verdict: ${out.text.slice(0, 200)}`);
    if (out.status === 402) reachedSettle++;
  }
  // The generator must actually reach the settle path, or this test proves nothing about it.
  assert.ok(reachedSettle > RUNS / 20, `only ${reachedSettle} of ${RUNS} inputs reached settle`);
});

test("no generated input makes /license/check answer 5xx, and every answer carries a verdict", async () => {
  const r = rng(SEED + 1);
  const a = app();
  for (let i = 0; i < RUNS; i++) {
    const input = {
      license: field(r, pick(r, NASTY_STRINGS) || "x"),
      resource: field(r, RESOURCE),
      slug: field(r, "essays/x"),
      kind: field(r, pick(r, ["read", "citation"])),
      proof: field(r, pick(r, NASTY_STRINGS)),
    };
    const raw = rawBody(r, input);
    const out = await send(a, "/_naulon/license/check", { method: "POST", headers: keyed, body: raw });
    assert.ok(out.status < 500, `${describe(SEED + 1, i, raw)} answered ${out.status} ${out.text.slice(0, 200)}`);
    if (out.status !== 403) assert.notEqual(gateVerdictOf(out.body), null, `${describe(SEED + 1, i, raw)} answered ${out.status} with no verdict`);
  }
});

test("no generated input makes /observe, /quote, /enforce-config or /enforce-status answer 5xx", async () => {
  const r = rng(SEED + 2);
  const a = app();
  for (let i = 0; i < RUNS; i++) {
    const report = { resource: field(r, RESOURCE), verdict: field(r, "served-free"), classifiedAs: field(r, "agent"), slug: field(r, "essays/x"), at: field(r, Date.now()), freeReason: field(r, "terms"), agent: field(r, {}) };
    const observeBody = r() < 0.5 ? [report, report] : report;
    const raw = rawBody(r, observeBody);
    const obs = await send(a, "/_naulon/observe", { method: "POST", headers: keyed, body: raw });
    assert.ok(obs.status < 500, `${describe(SEED + 2, i, raw)} /observe answered ${obs.status}`);

    const q = new URLSearchParams();
    for (const k of ["resource", "slug", "kind", "build", "observe", "verifiedAgent", "pricedFor"]) {
      const v = field(r, k === "resource" ? RESOURCE : k === "slug" ? "essays/x" : k === "kind" ? "read" : k === "build" ? "402" : "1");
      if (typeof v === "string") q.set(k, v);
    }
    const ua = pick(r, NASTY_STRINGS).replace(/[^\x20-\x7e]/g, "");
    for (const path of ["/_naulon/quote", "/_naulon/enforce-config", "/_naulon/enforce-status"]) {
      const out = await send(a, `${path}?${q}`, { headers: { authorization: "Bearer k", "user-agent": ua } });
      assert.ok(out.status < 500, `seed ${SEED + 2} run ${i}: ${path}?${q} answered ${out.status} ${out.text.slice(0, 200)}`);
    }
  }
});
