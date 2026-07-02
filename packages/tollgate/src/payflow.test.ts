/**
 * End-to-end gate flow through Hono's app.request: an agent hits a 402, pays,
 * gets content + a Citation License, and re-reads free with it. Covers the P2
 * bug checklist items that need the wired gate (mint-on-pay, re-read entitlement,
 * slug/kind binding, /licenses lookup, zero-address skip).
 *
 * Env is set BEFORE importing the app so config binds a tmp ledger and mock mode;
 * the origin fetch is stubbed so the success path returns without a live backend.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-payflow-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0"; // disable rate limiting for deterministic tests

const { app, createApp } = await import("./app.ts");
const { envPublisherResolver } = await import("./publisher.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { verifyLicense, walletAddress } = await import("@naulon/shared");
type JwkSet = import("@naulon/shared").JwkSet;

const PAYER = "0x1234567890abcdef1234567890abcdef12345678";

const realFetch = globalThis.fetch;
before(() => {
  // Stub the origin so proxyToOrigin resolves on the success path.
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function decodeJson(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}
function payload(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}
async function jwks(): Promise<JwkSet> {
  return (await (await app.request("/.well-known/naulon-jwks.json")).json()) as JwkSet;
}

/** Run the full 402 → pay handshake; return the post-payment Response. */
async function pay(slug: string, kind: "read" | "citation", payer = PAYER): Promise<Response> {
  const kindHeader = kind === "citation" ? { "x-naulon-kind": "citation" } : {};
  const first = await app.request(`/essays/${slug}`, {
    headers: { "x-naulon-agent": "tester", ...kindHeader },
  });
  assert.equal(first.status, 402, "unpaid agent should get 402");
  const required = first.headers.get(PAYMENT_REQUIRED_HEADER);
  assert.ok(required, "402 carries PAYMENT-REQUIRED");
  const accepts = (decodeJson(required).accepts as Array<{ amount: string; extra: { nonce: string } }>)[0]!;
  const sig = buildMockSignature(payer, accepts.amount, accepts.extra.nonce);
  return app.request(`/essays/${slug}`, {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig, ...kindHeader },
  });
}

test("pay → 200 + a verifiable X-Naulon-License", async () => {
  const res = await pay("on-stillness", "read");
  assert.equal(res.status, 200);
  const jws = res.headers.get("x-naulon-license");
  assert.ok(jws, "paid response carries a license");
  const claims = payload(jws!);
  const v = verifyLicense(jws!, {
    now: Date.now(),
    expectedIssuer: claims.iss as string,
    expectedAudience: claims.aud as string,
    jwks: await jwks(),
  });
  assert.ok(v.ok && v.claims.naulon.slug === "on-stillness");
  assert.ok(v.ok && v.claims.sub === PAYER);
});

test("a valid license re-reads the same slug FREE", async () => {
  const jws = (await pay("on-stillness", "read")).headers.get("x-naulon-license")!;
  const reread = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": jws },
  });
  assert.equal(reread.status, 200);
  assert.match(reread.headers.get("x-naulon-verdict") ?? "", /reread/);
});

test("a read license does NOT entitle a citation (no privilege upgrade)", async () => {
  const jws = (await pay("on-stillness", "read")).headers.get("x-naulon-license")!;
  const res = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-kind": "citation", "x-naulon-license": jws },
  });
  assert.equal(res.status, 402, "should fall through to payment");
});

test("a license for one slug does not unlock another", async () => {
  const jws = (await pay("on-stillness", "read")).headers.get("x-naulon-license")!;
  const res = await app.request("/essays/the-naulon", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": jws },
  });
  assert.equal(res.status, 402);
});

test("a malformed license falls through to 402, never 500 or free", async () => {
  const res = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": "not-a-token" },
  });
  assert.equal(res.status, 402);
});

test("GET /licenses/:jti finds a paid event by id; unknown is 404", async () => {
  const jws = (await pay("the-river-and-the-name", "read")).headers.get("x-naulon-license")!;
  const jti = payload(jws).jti as string;
  const found = await app.request(`/licenses/${jti}`);
  assert.equal(found.status, 200);
  const body = (await found.json()) as { found: boolean; event: { slug: string } };
  assert.equal(body.found, true);
  assert.equal(body.event.slug, "the-river-and-the-name");
  assert.equal((await app.request("/licenses/nope")).status, 404);
});

// The /licenses/:jti route resolves the publisher from Host and scopes the lookup
// to it — the seam that lets a multi-tenant embedder front many publishers from one
// gate without cross-tenant license disclosure. These boot a SECOND app over the
// SAME ledger (shared module sink) with a different-id resolver, standing in for
// another tenant, and assert the default-stamped event is invisible there.
test("GET /licenses/:jti is scoped — another publisher's host cannot read the event", async () => {
  const jws = (await pay("the-river-and-the-name", "read")).headers.get("x-naulon-license")!;
  const jti = payload(jws).jti as string;

  // Same env publisher config, but a different id — a different tenant in the fleet.
  // The event was stamped "default"; this resolver answers "other-tenant", so the
  // scope check must 404 (indistinguishable from not-found — confirms nothing).
  const otherTenant = createApp({
    async resolve(host: string) {
      const p = await envPublisherResolver().resolve(host);
      return p ? { ...p, id: "other-tenant" } : undefined;
    },
  });
  const leaked = await otherTenant.request(`/licenses/${jti}`);
  assert.equal(leaked.status, 404, "another tenant's host must not read the event");
  assert.equal(((await leaked.json()) as { found: boolean }).found, false);

  // Same jti, the owning ("default") publisher — still readable. Proves the 404 is
  // scoping, not a blanket break of the verify tier.
  const owned = await app.request(`/licenses/${jti}`);
  assert.equal(owned.status, 200);
});

test("GET /licenses/:jti returns 404 for an unknown host (fail-closed, no leak)", async () => {
  const jws = (await pay("the-river-and-the-name", "read")).headers.get("x-naulon-license")!;
  const jti = payload(jws).jti as string;
  // A resolver that serves no host — the unknown-host path. Must 404 without
  // confirming the jti exists at all.
  const noHost = createApp({ async resolve() { return undefined; } });
  assert.equal((await noHost.request(`/licenses/${jti}`)).status, 404);
});

test("no license is minted when the payer can't be resolved (zero-address guard)", async () => {
  const res = await pay("the-naulon", "read", "anon-not-an-address");
  assert.equal(res.status, 200); // still served — payment cleared
  assert.equal(res.headers.get("x-naulon-license"), null); // but no bearer token
});

// N-leg end-to-end: a publisher that declares an operator fee (the extraLegs hook a
// multi-tenant resolver populates) serves a 402 advertising the extra leg via
// naulonLegs; a buyer that signs every leg unlocks content. Proves the whole wire —
// quote.extraLegs → naulonLegs → per-leg verify/settle → content — through createApp.
test("N-leg: an operator-fee 402 carries naulonLegs and a multi-leg payment unlocks content", async () => {
  const OPERATOR = "0x3333333333333333333333333333333333333333";
  const feeApp = createApp({
    async resolve(host: string) {
      const p = await envPublisherResolver().resolve(host);
      // Declare a flat 500-µUSDC operator leg — what a control-plane resolver returns.
      return p ? { ...p, id: "fee-tenant", extraLegs: () => [{ role: "operator", payTo: walletAddress(OPERATOR), amount: "500" }] } : undefined;
    },
  });

  const first = await feeApp.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(first.status, 402);
  const required = decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!);
  assert.equal((required.accepts as unknown[]).length, 1, "accepts[0] stays the stock primary leg");
  const naulon = (required.extensions as { naulonLegs: { legs: Array<{ role: string; payTo: string; amount: string; nonce: string }> } }).naulonLegs;
  assert.equal(naulon.legs.length, 2);
  assert.equal(naulon.legs[1]!.role, "operator");
  assert.equal(naulon.legs[1]!.payTo.toLowerCase(), OPERATOR);
  assert.equal(naulon.legs[1]!.amount, "500");

  // Sign one mock authorization per leg (leg order) — the multi-leg buyer shape.
  const sig = Buffer.from(
    JSON.stringify(naulon.legs.map((l) => ({ payer: PAYER, amount: l.amount, nonce: l.nonce }))),
  ).toString("base64");
  const paid = await feeApp.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(paid.status, 200, "a fully-signed multi-leg payment unlocks content");
  assert.match(await paid.text(), /origin/);
  assert.ok(paid.headers.get("x-naulon-license"), "a paid multi-leg read still mints a license");
});

test("N-leg: a payment missing the operator leg is rejected — content stays gated", async () => {
  const OPERATOR = "0x3333333333333333333333333333333333333333";
  const feeApp = createApp({
    async resolve(host: string) {
      const p = await envPublisherResolver().resolve(host);
      return p ? { ...p, id: "fee-tenant-2", extraLegs: () => [{ role: "operator", payTo: walletAddress(OPERATOR), amount: "500" }] } : undefined;
    },
  });
  const first = await feeApp.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  const naulon = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).extensions as { naulonLegs: { legs: Array<{ amount: string; nonce: string }> } }).naulonLegs;
  // Sign ONLY the author leg — a single-leg payment against a two-leg quote.
  const sig = Buffer.from(JSON.stringify([{ payer: PAYER, amount: naulon.legs[0]!.amount, nonce: naulon.legs[0]!.nonce }])).toString("base64");
  const res = await feeApp.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(res.status, 402, "an incomplete multi-leg payment must not unlock content");
});
