/**
 * The gate's side of the licence-authority seam: a request presenting `Authorization: License`
 * is handed to the authority, and whatever payment it returns settles through the same path a
 * buyer-signed payment takes. The authority here is a fake that records every call.
 */
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naulon-licence-authority-"));
const EVENTS = join(dir, "events.jsonl");
process.env.EVENTS_PATH = EVENTS;
process.env.OBSERVATIONS_PATH = join(dir, "observations.jsonl");
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;
type LicenceAuthority = import("@naulon/shared").LicenceAuthority;
type LicenceAuthorizeRequest = import("@naulon/shared").LicenceAuthorizeRequest;
type LicenceVerdict = import("@naulon/shared").LicenceVerdict;
type LicenceReport = import("@naulon/shared").LicenceReport;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const HOST = "lic.example";
const AGENT = { host: HOST, "user-agent": "GPTBot/1.0", authorization: "License tok-1" };
const BODY = "<html>licensed</html>";

const PUB: PublisherConfig = {
  id: "lic",
  originUrl: "http://origin-lic.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "a1", wallet: AUTHOR }] };
    },
  },
  licenseIdentity: "naulon:lic.example",
};
const resolver: PublisherResolver = {
  async resolve(host) {
    return host === HOST ? PUB : undefined;
  },
};

const MANDATE = { kind: "olp" as const, tokenId: "olp-row-1", witness: "gate" as const };

/** A fake authority: answers with `respond(req)`, records every authorize and report. */
function fakeAuthority(respond: (req: LicenceAuthorizeRequest) => LicenceVerdict) {
  const calls: LicenceAuthorizeRequest[] = [];
  const reports: LicenceReport[] = [];
  const authority: LicenceAuthority = {
    async authorize(req) {
      calls.push(req);
      return respond(req);
    },
    async report(r) {
      reports.push(r);
    },
  };
  return { authority, calls, reports };
}

/** A mock payment for the gate's own 402, optionally underpaid so the settle refuses at verify. */
function payFor(req: LicenceAuthorizeRequest, underpay = false): string {
  const accepts = (JSON.parse(Buffer.from(req.header, "base64").toString("utf8")).accepts as Array<{
    amount: string;
    extra: { nonce: string };
  }>)[0]!;
  return buildMockSignature(PAYER, underpay ? "1" : accepts.amount, accepts.extra.nonce);
}

const charge = (underpay = false) => (req: LicenceAuthorizeRequest): LicenceVerdict => ({
  ok: true,
  kind: "charge",
  payment: payFor(req, underpay),
  grantId: "g-1",
  mandate: MANDATE,
});

let originStatus = 200;
let originThrows = false;
let originHits = 0;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => {
    originHits++;
    if (originThrows) throw new TypeError("fetch failed");
    return new Response(originStatus === 200 ? BODY : "missing", {
      status: originStatus,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  originStatus = 200;
  originThrows = false;
  originHits = 0;
});

function lastEvent(): Record<string, unknown> | undefined {
  if (!existsSync(EVENTS)) return undefined;
  const lines = readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean);
  return lines.length ? (JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>) : undefined;
}
const eventCount = () => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).length : 0);

test("no authority: a licence token gets the ordinary 402", async () => {
  const app = createApp(resolver);
  const res = await app.request("/essays/a", { headers: AGENT });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get(PAYMENT_REQUIRED_HEADER));
  assert.equal(originHits, 0);
});

test("authority refuses 401: the header names the scheme and nothing is proxied", async () => {
  const f = fakeAuthority(() => ({ ok: false, status: 401, error: "invalid_token", description: "unknown token" }));
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/a", { headers: AGENT });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), 'License error="invalid_token"');
  assert.deepEqual(await res.json(), { error: "invalid_token", error_description: "unknown token" });
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /licence refused \(invalid_token\)/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(originHits, 0);
  assert.equal(f.reports.length, 0);
  // What the authority was asked: the token, the tenant, the canonical URL and the gate's own 402.
  const call = f.calls[0]!;
  assert.equal(call.token, "tok-1");
  assert.equal(call.publisherId, "lic");
  assert.equal(call.host, HOST);
  assert.equal(call.resource, `https://${HOST}/essays/a`);
  assert.equal(call.slug, "a");
  assert.equal(call.tollKind, "read");
  assert.ok(call.header.length > 0 && call.legs.length >= 1);
  assert.equal(call.signer, undefined);
});

test("authority 402: the refusal still carries PAYMENT-REQUIRED so the crawler can buy over x402", async () => {
  const f = fakeAuthority(() => ({ ok: false, status: 402, error: "price_rose" }));
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/a", { headers: AGENT });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get(PAYMENT_REQUIRED_HEADER), f.calls[0]!.header);
  assert.deepEqual(await res.json(), { error: "price_rose" });
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("authority 503: retry-after tells the crawler when to come back", async () => {
  const f = fakeAuthority(() => ({ ok: false, status: 503, error: "in_flight" }));
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/a", { headers: AGENT });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
  // A charge for this URL is already running: advertising x402 here would invite a second payment.
  assert.equal(res.headers.get(PAYMENT_REQUIRED_HEADER), null);
});

test("authority says held: served as a re-read, no settle, no report", async () => {
  const f = fakeAuthority(() => ({ ok: true, kind: "held", mandate: MANDATE }));
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const before = eventCount();
  const res = await app.request("/essays/a", { headers: AGENT });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BODY);
  assert.equal(res.headers.get("x-naulon-verdict"), "agent reread (licence)");
  assert.equal(eventCount(), before);
  assert.equal(f.reports.length, 0);
});

test("authority charges: settles the returned payment, event carries the mandate, report(settled) fires with the event id", async () => {
  const f = fakeAuthority(charge());
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/b", { headers: AGENT });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), BODY);
  const ev = lastEvent()!;
  assert.deepEqual(ev.mandate, MANDATE);
  assert.equal(ev.resource, `https://${HOST}/essays/b`);
  assert.deepEqual(f.reports, [{ grantId: "g-1", outcome: "settled", eventId: ev.id }]);
});

test("settle refused at verify: report(unpaid), and the crawler gets the 402", async () => {
  const f = fakeAuthority(charge(true));
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const before = eventCount();
  const res = await app.request("/essays/c", { headers: AGENT });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get(PAYMENT_REQUIRED_HEADER));
  assert.equal(eventCount(), before);
  assert.deepEqual(f.reports, [{ grantId: "g-1", outcome: "unpaid" }]);
});

test("origin 404 before the settle: report(unpaid), 404 to the crawler", async () => {
  originStatus = 404;
  const f = fakeAuthority(charge());
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const before = eventCount();
  const res = await app.request("/essays/d", { headers: AGENT });
  assert.equal(res.status, 404);
  assert.equal(eventCount(), before);
  assert.deepEqual(f.reports, [{ grantId: "g-1", outcome: "unpaid" }]);
});

test("a report that throws never changes the response", async () => {
  const f = fakeAuthority(charge());
  f.authority.report = async () => {
    throw new Error("store down");
  };
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/e", { headers: AGENT });
  assert.equal(res.status, 200);
});

test("a human presenting a licence never reaches the authority", async () => {
  const f = fakeAuthority(charge());
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/f", {
    headers: { host: HOST, "user-agent": "Mozilla/5.0 (real browser)", authorization: "License tok-1" },
  });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test("an origin that cannot be reached before the settle: report(unpaid), so the reserve comes back", async () => {
  originThrows = true;
  const f = fakeAuthority(charge());
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const before = eventCount();
  const res = await app.request("/essays/g", { headers: AGENT });
  assert.notEqual(res.status, 200);
  assert.equal(eventCount(), before);
  assert.deepEqual(f.reports, [{ grantId: "g-1", outcome: "unpaid" }]);
});

test("a HEAD with a licence token is never charged: the authority is not asked, the 402 is ordinary", async () => {
  const f = fakeAuthority(charge());
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/h", { method: "HEAD", headers: AGENT });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get(PAYMENT_REQUIRED_HEADER));
  assert.equal(f.calls.length, 0);
});

test("an authority that throws answers 503 with retry-after, still buyable over x402, nothing proxied", async () => {
  const f = fakeAuthority(() => {
    throw new Error("store down");
  });
  const app = createApp(resolver, { licenceAuthority: f.authority });
  const res = await app.request("/essays/i", { headers: AGENT });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
  assert.ok(res.headers.get(PAYMENT_REQUIRED_HEADER));
  assert.equal(((await res.json()) as { error: string }).error, "licence_server_unavailable");
  assert.equal(originHits, 0);
  assert.equal(f.reports.length, 0);
});

test("observe: a presented licence is never sent to the authority, which could charge it", async () => {
  const f = fakeAuthority(charge());
  const observing: PublisherResolver = { async resolve(host) { return host === HOST ? { ...PUB, tollMode: "observe" } : undefined; } };
  const app = createApp(observing, { licenceAuthority: f.authority });
  const res = await app.request("/essays/observed", { headers: AGENT });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0, "an observing site must never ask the authority");
  assert.deepEqual(f.reports, []);
});
