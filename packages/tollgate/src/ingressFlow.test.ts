/**
 * Crawler route, end to end through the gate: a publisher's CDN proxies crawler traffic to the
 * shared ingress, naming the site in `Forwarded: host=` and authenticating with its edge secret.
 *
 * Two tenants share the ingress, because the property that matters most is that one can never be
 * named with the other's secret. Every refusal is compared against the gate's ordinary unknown-Host
 * answer, because an ingress that answered differently would tell a stranger which sites exist.
 * The last tests prove the other direction: a request on any other host behaves as it always did.
 */
import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttributedEvent, ObservationEvent, PublisherConfig } from "@naulon/shared";

const EVENTS_PATH = join(tmpdir(), `naulon-ingress-events-${process.pid}.jsonl`);
const OBS_PATH = join(tmpdir(), `naulon-ingress-obs-${process.pid}.jsonl`);
process.env.EVENTS_PATH = EVENTS_PATH;
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { edgeSecretDigest } = await import("./ingress.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");

const INGRESS = "ingress.naulon.test";
const alphaEdge = randomBytes(24).toString("hex");
const betaEdge = randomBytes(24).toString("hex");
const alphaOrigin = `nlo_${randomBytes(12).toString("hex")}`;

function pub(id: string, site: string, originAuthSecret?: string): PublisherConfig {
  return {
    id,
    originUrl: `https://origin.${id}.example`,
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: {
      async resolve(slug: string) {
        return { slug, title: slug, contributors: [{ authorId: "a", wallet: walletAddress("0x0000000000000000000000000000000000000001") }] };
      },
    },
    licenseIdentity: `naulon:${site}`,
    ...(originAuthSecret ? { originAuthSecret } : {}),
  };
}

const alpha = pub("alpha", "www.alpha.example", alphaOrigin);
const beta = pub("beta", "www.beta.example");
const routed = pub("routed", "p.example");

const app = createApp(
  { async resolve(host) { return host === "p.example" ? routed : undefined; } },
  {
    ingress: {
      host: INGRESS,
      async resolve(site) {
        if (site === "www.alpha.example") return { config: alpha, edgeSecretDigests: [edgeSecretDigest(alphaEdge)] };
        if (site === "www.beta.example") return { config: beta, edgeSecretDigests: [edgeSecretDigest(betaEdge)] };
        return undefined;
      },
    },
  },
);

const realFetch = globalThis.fetch;
let origin: Array<{ url: string; headers: Headers }> = [];
before(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    origin.push({ url: String(input), headers: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]) });
    return new Response("<html>origin</html>", {
      status: 200,
      headers: { "content-type": "text/html", "cache-control": "public, max-age=600" },
    });
  }) as typeof fetch;
});
beforeEach(() => { origin = []; });
after(() => { globalThis.fetch = realFetch; });

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

function viaIngress(path: string, opts: { site?: string; edge?: string | null; forwarded?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: INGRESS, "user-agent": GPTBOT, ...opts.headers };
  const fwd = opts.forwarded ?? `for=203.0.113.9;host=${opts.site ?? "www.alpha.example"};proto=https`;
  if (fwd) headers.forwarded = fwd;
  const edge = opts.edge === undefined ? alphaEdge : opts.edge;
  if (edge !== null) headers["x-naulon-edge-auth"] = edge;
  return app.request(path, { headers });
}

function decodeJson(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}
function payload(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}
/** observe() is fire-and-forget, so the append can lag the response: poll until a row appears. */
async function waitForObs(slug: string): Promise<ObservationEvent[]> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const found = (await lines<ObservationEvent>(OBS_PATH)).filter((o) => o.slug === slug);
    if (found.length > 0) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for an observation of ${slug}`);
}
async function lines<T>(path: string): Promise<T[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

test("a crawler through the ingress gets a 402 whose signed resource names the SITE, not the ingress", async () => {
  const res = await viaIngress("/essays/on-stillness?utm=x");
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const required = decodeJson(res.headers.get(PAYMENT_REQUIRED_HEADER)!);
  const resource = required.resource as { url: string };
  assert.equal(resource.url, "https://www.alpha.example/essays/on-stillness?utm=x");
  assert.ok((await res.text()).includes("www.alpha.example"), "the 402 body names the site");
  assert.equal(origin.length, 0, "an unpaid 402 fetches nothing from the origin");
});

test("paid through the ingress: licence, event and origin fetch all name the site", async () => {
  const first = await viaIngress("/essays/paid-one");
  const accepts = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).accepts as Array<{ amount: string; extra: { nonce: string } }>)[0]!;
  const sig = buildMockSignature(walletAddress("0x00000000000000000000000000000000000000b1"), accepts.amount, accepts.extra.nonce);
  const res = await viaIngress("/essays/paid-one", { headers: { [PAYMENT_SIGNATURE_HEADER]: sig } });
  assert.equal(res.status, 200);

  const claims = payload(res.headers.get("x-naulon-license")!);
  assert.equal(claims.iss, "naulon:www.alpha.example");
  assert.equal((claims.naulon as { resource: string }).resource, "https://www.alpha.example/essays/paid-one");

  const event = (await lines<AttributedEvent>(EVENTS_PATH)).find((e) => e.slug === "paid-one");
  assert.equal(event?.host, "www.alpha.example");
  assert.equal(event?.servedVia, "ingress");
  assert.equal(event?.publisherId, "alpha");

  assert.equal(origin.length, 1);
  const o = origin[0]!;
  assert.equal(new URL(o.url).host, "origin.alpha.example");
  assert.equal(o.headers.get("x-forwarded-host"), "www.alpha.example");
  assert.equal(o.headers.get("x-forwarded-for"), "203.0.113.9", "the crawler's address, not the CDN's");
  assert.equal(o.headers.get("x-naulon-origin-auth"), alphaOrigin);
  assert.ok(o.headers.get("cdn-loop")?.includes("naulon"), "the origin fetch carries our loop token");
  assert.equal(o.headers.get("forwarded"), null);
  assert.equal(o.headers.get("x-naulon-edge-auth"), null, "the edge secret never reaches an origin");
});

test("a browser-shaped request that reached the ingress reads free, with no redirect", async () => {
  const res = await viaIngress("/essays/human", {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", accept: "text/html", "sec-fetch-mode": "navigate" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get("cache-control"), "private, max-age=600", "one hostname for every site: never shared-cacheable");
});

test("an ambiguous client is an agent on the ingress and a human everywhere else", async () => {
  const ambiguous = { "user-agent": "fetch-client/1.0", accept: "*/*" };
  const routedRes = await viaIngress("/essays/ambiguous", { headers: ambiguous });
  assert.equal(routedRes.status, 402);
  const normal = await app.request("/essays/ambiguous", { headers: { host: "p.example", ...ambiguous } });
  assert.equal(normal.status, 200);
});

test("every refusal is byte-identical to the unknown-Host answer, and fetches nothing", async () => {
  const unknown = await app.request("/essays/x", { headers: { host: "nobody.example", "user-agent": GPTBOT } });
  const want = { status: unknown.status, body: await unknown.text() };
  const cases: Array<[string, Response | Promise<Response>]> = [
    ["no Forwarded", viaIngress("/essays/x", { forwarded: "" })],
    ["no edge secret", viaIngress("/essays/x", { edge: null })],
    ["wrong edge secret", viaIngress("/essays/x", { edge: randomBytes(24).toString("hex") })],
    ["unknown site", viaIngress("/essays/x", { site: "www.nobody.example" })],
    ["beta's secret naming alpha", viaIngress("/essays/x", { site: "www.alpha.example", edge: betaEdge })],
    ["alpha's secret naming beta", viaIngress("/essays/x", { site: "www.beta.example", edge: alphaEdge })],
    ["the ingress naming itself", viaIngress("/essays/x", { site: INGRESS })],
    ["an IP literal", viaIngress("/essays/x", { site: "203.0.113.9" })],
  ];
  for (const [name, p] of cases) {
    const res = await p;
    assert.deepEqual({ status: res.status, body: await res.text() }, want, name);
  }
  assert.equal(origin.length, 0);
});

test("a spoofed earlier Forwarded element never names the site; the CDN's last one does", async () => {
  const spoofedFirst = await viaIngress("/essays/x", { forwarded: "host=www.beta.example, for=203.0.113.9;host=www.alpha.example" });
  assert.equal(spoofedFirst.status, 402, "admitted as alpha, the element the CDN wrote");
  const spoofedLast = await viaIngress("/essays/x", { forwarded: "host=www.alpha.example, for=203.0.113.9;host=www.beta.example" });
  assert.equal(spoofedLast.status, 502, "names beta, and alpha's secret does not open beta");
});

test("our own origin fetch coming back through the CDN is refused as a loop, fetching nothing", async () => {
  const byOriginAuth = await viaIngress("/essays/x", { headers: { "x-naulon-origin-auth": alphaOrigin } });
  assert.equal(byOriginAuth.status, 508);
  assert.equal(byOriginAuth.headers.get("cache-control"), "no-store");
  const byCdnLoop = await viaIngress("/essays/x", { headers: { "cdn-loop": "cloudflare, naulon" } });
  assert.equal(byCdnLoop.status, 508);
  const otherCdnOnly = await viaIngress("/essays/x", { headers: { "cdn-loop": "cloudflare" } });
  assert.equal(otherCdnOnly.status, 402, "another CDN's token alone is not our loop");
  const wrongOriginAuth = await viaIngress("/essays/x", { headers: { "x-naulon-origin-auth": "not-the-origin-value" } });
  assert.equal(wrongOriginAuth.status, 402);
  assert.equal(origin.length, 0);
});

test("the ingress host is matched without case or port", async () => {
  const res = await app.request("/essays/x", {
    headers: {
      host: "INGRESS.naulon.test:443",
      "user-agent": GPTBOT,
      forwarded: "host=www.alpha.example",
      "x-naulon-edge-auth": alphaEdge,
    },
  });
  assert.equal(res.status, 402);
});

test("observations name the site and say it came through the ingress", async () => {
  await viaIngress("/essays/observed-one");
  const obs = await waitForObs("observed-one");
  for (const o of obs) {
    assert.equal(o.host, "www.alpha.example");
    assert.equal(o.servedVia, "ingress");
  }
});

test("on any other host, Forwarded and an edge secret are ignored and nothing changes", async () => {
  const res = await app.request("/essays/routed-one", {
    headers: {
      host: "p.example",
      "user-agent": "Mozilla/5.0 Safari",
      accept: "text/html",
      forwarded: "host=www.alpha.example",
      "x-naulon-edge-auth": alphaEdge,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=600", "the origin's own caching is untouched");
  assert.equal(origin[0]?.headers.get("x-forwarded-host"), "p.example");
  assert.equal(origin[0]?.headers.get("cdn-loop"), null, "no loop token outside the ingress");
  assert.equal(origin[0]?.headers.get("x-naulon-edge-auth"), null);
  const obs = await waitForObs("routed-one");
  for (const o of obs) {
    assert.equal(o.host, "p.example");
    assert.equal(o.servedVia, undefined);
  }
});

// Machine URLs. A crawler that met a 402 through the CDN follows its links through the same CDN, so
// they arrive on the ingress too; a verifier's browser does not pass the CDN's crawler rule at all,
// so a relative URL would send it to the site's origin, which has no such route.

const ABS = `https://${INGRESS}`;
const ALPHA_Q = "?host=www.alpha.example";

test("a 402 through the ingress links an absolute manifest URL that names the site", async () => {
  const res = await viaIngress("/essays/linked");
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("link"), `<${ABS}/.well-known/x402${ALPHA_Q}>; rel="payment"; type="application/json"`);
});

test("the manifest answers for the site both through the CDN and by ?host=, with absolute URLs", async () => {
  const unknown = await app.request("/essays/x", { headers: { host: "nobody.example", "user-agent": GPTBOT } });
  const miss = { status: unknown.status, body: await unknown.text() };
  const throughCdn = await viaIngress("/.well-known/x402");
  const byHint = await app.request(`/.well-known/x402${ALPHA_Q}`, { headers: { host: INGRESS } });
  for (const [name, res] of [["through the CDN", throughCdn], ["by ?host=", byHint]] as const) {
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get("cache-control") ?? "", /^private/, `${name}: one ingress URL serves every site`);
    const m = (await res.json()) as { license: Record<string, string> };
    assert.equal(m.license.identity, "naulon:www.alpha.example", name);
    assert.equal(m.license.verify, `${ABS}/licenses/{jti}${ALPHA_Q}`, name);
    assert.equal(m.license.record, `${ABS}/licenses/{jti}/record${ALPHA_Q}`, name);
    assert.equal(m.license.jwks, `${ABS}/.well-known/naulon-jwks.json`, name);
  }
  const noHint = await app.request("/.well-known/x402", { headers: { host: INGRESS } });
  assert.equal(noHint.status, 404, "no site named, no terms");
  const wrongSecret = await viaIngress("/.well-known/x402", { edge: randomBytes(24).toString("hex") });
  assert.deepEqual({ status: wrongSecret.status, body: await wrongSecret.text() }, miss, "a forwarded request still needs its secret");
});

test("a verifier reaches a licence on the ingress by ?host=, and only under its own site", async () => {
  const first = await viaIngress("/essays/verify-me");
  const accepts = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).accepts as Array<{ amount: string; extra: { nonce: string } }>)[0]!;
  const sig = buildMockSignature(walletAddress("0x00000000000000000000000000000000000000b2"), accepts.amount, accepts.extra.nonce);
  const paid = await viaIngress("/essays/verify-me", { headers: { [PAYMENT_SIGNATURE_HEADER]: sig } });
  const jti = payload(paid.headers.get("x-naulon-license")!).jti as string;

  const get = (path: string) => app.request(path, { headers: { host: INGRESS } });
  const found = await get(`/licenses/${jti}${ALPHA_Q}`);
  assert.equal(found.status, 200);
  assert.equal(((await found.json()) as { found: boolean }).found, true);
  assert.equal((await get(`/licenses/${jti}/record${ALPHA_Q}`)).status, 200);
  assert.equal((await get(`/licenses/${jti}?host=www.beta.example`)).status, 404, "another site never sees alpha's licence");
  assert.equal((await get(`/licenses/${jti}`)).status, 404, "no site named, nothing found");
  const through = await viaIngress(`/licenses/${jti}`);
  assert.equal(through.status, 200, "a crawler checking its licence through the CDN reaches it too");
});

test("the gate's own routes answer on the ingress, and nothing else does without a secret", async () => {
  assert.equal((await app.request("/.well-known/naulon-edge", { headers: { host: INGRESS } })).status, 200);
  assert.equal((await app.request("/.well-known/naulon-jwks.json", { headers: { host: INGRESS } })).status, 200);
  const unknown = await app.request("/essays/x", { headers: { host: "nobody.example" } });
  const miss = { status: unknown.status, body: await unknown.text() };
  const post = await app.request("/healthz", { method: "POST", headers: { host: INGRESS } });
  assert.deepEqual({ status: post.status, body: await post.text() }, miss);
  const hintedPath = await app.request(`/essays/x${ALPHA_Q}`, { headers: { host: INGRESS, "user-agent": GPTBOT } });
  assert.deepEqual({ status: hintedPath.status, body: await hintedPath.text() }, miss, "?host= opens machine routes only");
  assert.equal(origin.length, 0);
});

test("on any other host the 402 link and the manifest URLs stay relative", async () => {
  const res = await app.request("/essays/relative", { headers: { host: "p.example", "user-agent": GPTBOT } });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("link"), '</.well-known/x402>; rel="payment"; type="application/json"');
  const m = (await (await app.request("/.well-known/x402", { headers: { host: "p.example" } })).json()) as { license: Record<string, string> };
  assert.equal(m.license.verify, "/licenses/{jti}");
  assert.equal(m.license.jwks, "/.well-known/naulon-jwks.json");
});
