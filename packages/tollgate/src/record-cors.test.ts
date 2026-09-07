/**
 * The citation record must be reachable FROM A BROWSER, and a browser must be able to say
 * which publisher it is asking about.
 *
 * The proof link a citation carries (`naulon.app/verify?host=…&jti=…`) is opened by a stranger
 * whose browser then fetches `/licenses/:jti/record` and checks the signature against the
 * issuer's published keys. Two things stood between that and working, measured 2026-09-03:
 *
 *   1. the record route sent no `access-control-allow-origin`, so the same-origin policy blocked
 *      the fetch before any signature was checked — the JWKS had the identical defect on 09-02;
 *   2. the route resolves the publisher from `Host`, and a browser cannot set `Host`. A publisher
 *      serving their own site through the SDK has no record route on their origin at all, and the
 *      fleet edge answers a spoofed `Host` with 403 — so from a browser there was NO way to name
 *      such a publisher. `?host=` is that way. It widens who can ASK from a browser and nothing
 *      about what may be read: the `publisherId` ownership check is unchanged, and a `curl` with a
 *      chosen `Host` could already ask the same question.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-record-cors-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { app, createApp } = await import("./app.ts");
const { envPublisherResolver } = await import("./publisher.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");

const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const ORIGIN = { origin: "https://naulon.app" };

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
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

/** Pay a mock toll and return the licence jti — the record's id. */
async function paidJti(slug: string): Promise<string> {
  const first = await app.request(`/essays/${slug}`, { headers: { "x-naulon-agent": "tester" } });
  assert.equal(first.status, 402);
  const accepts = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).accepts as Array<{ amount: string; extra: { nonce: string } }>)[0]!;
  const sig = buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce);
  const paid = await app.request(`/essays/${slug}`, {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(paid.status, 200);
  return payload(paid.headers.get("x-naulon-license")!).jti as string;
}

test("the record is fetchable cross-origin, and cacheable — it is permanent", async () => {
  const jti = await paidJti("on-stillness");
  const res = await app.request(`/licenses/${jti}/record`, { headers: ORIGIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control") ?? "", /public/);
  const body = (await res.json()) as { found: boolean; record: string };
  assert.equal(body.found, true);
  assert.equal(body.record.split(".").length, 3, "the record is a compact JWS");
});

test("it answers a browser's preflight", async () => {
  const res = await app.request("/licenses/anything/record", {
    method: "OPTIONS",
    headers: { origin: "https://example.test", "access-control-request-method": "GET" },
  });
  assert.ok(res.status === 200 || res.status === 204, `preflight must not fail: got ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("a 404 is ALSO cross-origin readable, and never cached — so a browser can tell 'not here' from 'unreachable'", async () => {
  const res = await app.request("/licenses/no-such-jti/record", { headers: ORIGIN });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(((await res.json()) as { found: boolean }).found, false);
});

test("?host= names the publisher when Host routes nothing — the self-served publisher's record, from a browser", async () => {
  const jti = await paidJti("the-river-and-the-name");
  // Routes nothing (the in-app shape); OWNS exactly one host.
  const selfServed = createApp(
    { async resolve() { return undefined; } },
    { resolveInAppConfig: async (host) => (host === "owned.example" ? envPublisherResolver().resolve(host) : undefined) },
  );
  const without = await selfServed.request(`/licenses/${jti}/record`, { headers: ORIGIN });
  assert.equal(without.status, 404, "with no hint, the request's own Host routes nothing — as before");

  const hinted = await selfServed.request(`/licenses/${jti}/record?host=owned.example`, { headers: ORIGIN });
  assert.equal(hinted.status, 200, "the hint resolves the owner, so the record mints");
  assert.equal(hinted.headers.get("access-control-allow-origin"), "*");
  const rec = payload(((await hinted.json()) as { record: string }).record);
  assert.equal(rec.iss, "naulon:owned.example", "the record is issued under the HINTED publisher's identity");

  const unknown = await selfServed.request(`/licenses/${jti}/record?host=nobody.example`, { headers: ORIGIN });
  assert.equal(unknown.status, 404, "a hint naming a host nobody owns is the same 404");
});

test("the hint widens who can ASK, never what may be read — a foreign publisher's hint is a 404", async () => {
  const jti = await paidJti("the-river-and-the-name");
  const otherOwner = createApp(
    { async resolve() { return undefined; } },
    {
      resolveInAppConfig: async (host) => {
        const p = await envPublisherResolver().resolve(host);
        return p ? { ...p, id: "other-tenant" } : undefined;
      },
    },
  );
  const leaked = await otherOwner.request(`/licenses/${jti}/record?host=other.example`, { headers: ORIGIN });
  assert.equal(leaked.status, 404, "the event is stamped to another publisher; the hint must not unlock it");
  assert.equal(((await leaked.json()) as { found: boolean }).found, false);
});

test("a malformed hint is ignored rather than resolved — a host is a host, not a path or a scheme", async () => {
  const jti = await paidJti("on-stillness");
  const selfServed = createApp(
    { async resolve() { return undefined; } },
    { resolveInAppConfig: async (host) => (host === "owned.example" ? envPublisherResolver().resolve(host) : undefined) },
  );
  const control = await selfServed.request(`/licenses/${jti}/record?host=owned.example`);
  assert.equal(control.status, 200, "the well-formed hint resolves — so a 404 below is the shape being refused");
  for (const bad of ["https://owned.example", "owned.example/licenses", "owned.example?x=1", "a b"]) {
    const res = await selfServed.request(`/licenses/${jti}/record?host=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, `hint ${JSON.stringify(bad)} must be ignored, not cleaned into a host`);
  }
});

test("CORS stays scoped — the raw event route and a tolled path do not become cross-origin readable", async () => {
  const jti = await paidJti("on-stillness");
  const event = await app.request(`/licenses/${jti}`, { headers: ORIGIN });
  assert.equal(event.status, 200);
  assert.equal(event.headers.get("access-control-allow-origin"), null, "the raw ledger row is not the public document");
  const tolled = await app.request("/essays/on-stillness", { headers: { ...ORIGIN, "user-agent": "GPTBot/1.0" } });
  assert.equal(tolled.headers.get("access-control-allow-origin"), null);
});
