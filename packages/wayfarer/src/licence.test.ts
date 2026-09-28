import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher } from "@naulon/sdk/crawl";
import { isNaulonLicenceServer, makeLicenceResolver } from "./licence.ts";
import { clearLicenseTokens, licenseTokenFor } from "./license-token.ts";
import { resetConfig } from "@naulon/shared";
import { resetAgentIdentity } from "./sign.ts";

const DOC = (price: string, extra = "") => `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/"${extra}><license><permits type="usage">ai-input</permits>
  <payment type="crawl"><amount currency="USD">${price}</amount>
  <accepts type="application/x402+json"/></payment></license></content></rsl>`;

function fakeNet(routes: Record<string, { status?: number; body?: string }>) {
  const asked: string[] = [];
  const fetcherFor = (_origin: string): Fetcher => async (url) => {
    asked.push(url);
    const r = routes[url];
    const status = r ? (r.status ?? 200) : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return r?.body ?? ""; },
      async json() { return null; },
    };
  };
  return { fetcherFor, asked };
}

const ROBOTS_SITE = {
  "https://pub.example/robots.txt": { body: "User-agent: *\nLicense: https://pub.example/license.xml" },
  "https://pub.example/license.xml": { body: DOC("0.01") },
};

test("terms resolve from the origin's robots licence", async () => {
  const net = fakeNet(ROBOTS_SITE);
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const got = await r.forUrl("https://pub.example/articles/x");
  assert.equal(got.source, "robots");
  assert.equal(got.terms?.usage["ai-input"], true);
  assert.deepEqual(got.terms?.read?.amount, { value: 0.01, currency: "USD" });
});

test("one origin is fetched ONCE for many candidates, and concurrently too", async () => {
  const net = fakeNet(ROBOTS_SITE);
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  // Concurrent: the in-flight dedupe is what stops ten candidates becoming ten robots fetches on
  // a stranger's server.
  await Promise.all([1, 2, 3, 4, 5].map((n) => r.forUrl(`https://pub.example/a/${n}`)));
  await r.forUrl("https://pub.example/a/6"); // and again, from the cache
  assert.equal(net.asked.filter((u) => u.endsWith("/robots.txt")).length, 1);
  assert.equal(net.asked.filter((u) => u.endsWith("/license.xml")).length, 1);
  assert.equal(r.originsSeen(), 1);
});

test("the NEGATIVE answer is cached too — it is the common one and the costly one to re-learn", async () => {
  const net = fakeNet({ "https://bare.example/robots.txt": { body: "User-agent: *\nDisallow:" } });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  assert.equal((await r.forUrl("https://bare.example/a")).terms, null);
  assert.equal((await r.forUrl("https://bare.example/b")).terms, null);
  assert.equal(net.asked.length, 1);
});

test("a failed lookup is NOT cached as 'no licence' — a timeout is a fact about the network", async () => {
  let calls = 0;
  const flaky = (): Fetcher => async (url) => {
    calls += 1;
    if (calls === 1) throw new Error("ETIMEDOUT");
    return {
      ok: true,
      status: 200,
      async text() {
        return url.endsWith("robots.txt") ? "License: https://pub.example/license.xml" : DOC("0.02");
      },
      async json() { return null; },
    };
  };
  const r = makeLicenceResolver({ fetcherFor: flaky });
  assert.equal((await r.forUrl("https://pub.example/a")).terms, null, "first attempt fails");
  const second = await r.forUrl("https://pub.example/b");
  assert.equal(second.terms?.read?.amount?.value, 0.02, "the retry is allowed to succeed");
});

test("a page-level licence wins over the origin's, and is not cached against the origin", async () => {
  const net = fakeNet({
    ...ROBOTS_SITE,
    "https://pub.example/page.xml": { body: DOC("0.99") },
  });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const observed = { headers: { link: '</page.xml>; rel="license"; type="application/rsl+xml"' } };
  const page = await r.forUrl("https://pub.example/priced", observed);
  assert.equal(page.source, "link-header");
  assert.equal(page.terms?.read?.amount?.value, 0.99);
  assert.equal(r.originsSeen(), 0, "a per-url answer must never become the whole site's");

  // A different url on the same origin still gets the site-wide terms.
  const other = await r.forUrl("https://pub.example/other");
  assert.equal(other.source, "robots");
  assert.equal(other.terms?.read?.amount?.value, 0.01);
});

test("terms expire, so a publisher who changes their price is not quoted the old one forever", async () => {
  let body = DOC("0.01");
  const fetcherFor = (): Fetcher => async (url) => ({
    ok: true,
    status: 200,
    async text() { return url.endsWith("robots.txt") ? "License: https://pub.example/license.xml" : body; },
    async json() { return null; },
  });
  const r = makeLicenceResolver({ fetcherFor, ttlMs: 0 });
  assert.equal((await r.forUrl("https://pub.example/a")).terms?.read?.amount?.value, 0.01);
  body = DOC("0.05");
  assert.equal((await r.forUrl("https://pub.example/a")).terms?.read?.amount?.value, 0.05);
});

test("a document that governs the origin but not this url reads as no terms", async () => {
  const net = fakeNet({
    "https://pub.example/robots.txt": { body: "License: https://pub.example/l.xml" },
    "https://pub.example/l.xml": {
      body: `<rsl xmlns="https://rslstandard.org/rsl"><content url="/articles/*">
        <license><permits type="usage">ai-input</permits></license></content></rsl>`,
    },
  });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  assert.equal((await r.forUrl("https://pub.example/about")).terms, null);
  assert.notEqual((await r.forUrl("https://pub.example/articles/x")).terms, null);
});

test("a malformed url resolves to no terms without touching the network", async () => {
  const net = fakeNet({});
  assert.equal((await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("nope")).terms, null);
  assert.equal(net.asked.length, 0);
});

/* ── the licence-server obligation, discharged ───────────────────────────────────────────────── */

const SERVER_DOC = `<rsl xmlns="https://rslstandard.org/rsl">
  <content url="/" server="https://olp.example/api">
    <license><permits type="usage">ai-input</permits>
    <payment type="crawl"><amount currency="USD">0.01</amount></payment></license></content></rsl>`;

/** robots → a licence naming a server, plus whatever the OLP token endpoint should answer. */
function serverSite(tokenReply: { status?: number; json?: unknown }) {
  const asked: string[] = [];
  const tokenHeaders: Array<Record<string, string>> = [];
  const fetcherFor = (_origin: string): Fetcher => async (url, init) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/token")) tokenHeaders.push((init?.headers as Record<string, string>) ?? {});
    if (url.endsWith("/robots.txt")) return ok("License: https://pub.example/license.xml");
    if (url.endsWith("/license.xml")) return ok(SERVER_DOC);
    if (url.endsWith("/token")) {
      const status = tokenReply.status ?? 200;
      const body = JSON.stringify(tokenReply.json ?? {});
      return { ok: status >= 200 && status < 300, status, async text() { return body; }, async json() { return JSON.parse(body) as unknown; } };
    }
    return { ok: false, status: 404, async text() { return ""; }, async json() { return null; } };
  };
  const ok = (body: string) => ({ ok: true, status: 200, async text() { return body; }, async json() { return null; } });
  return { fetcherFor, asked, tokenHeaders };
}

test("a licence server with no configured credentials is reported, not paid around", async () => {
  const net = serverSite({});
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const got = await r.forUrl("https://pub.example/a");
  assert.equal(got.terms?.obligation, "license-server");
  assert.equal(got.tokenHeld, false);
  assert.match(got.tokenFailure ?? "", /no client credentials/);
  assert.ok(!net.asked.some((a) => a.includes("/token")), "we must not POST to a server we cannot authenticate to");
});

test("with credentials, the obligation is discharged and the token is remembered", async () => {
  clearLicenseTokens();
  const net = serverSite({ json: { access_token: "tok-abc", token_type: "License", expires_in: 3600 } });
  const r = makeLicenceResolver({
    fetcherFor: net.fetcherFor,
    licenseServers: (server) => (server === "https://olp.example/api" ? { clientId: "id", clientSecret: "sec" } : null),
  });
  const got = await r.forUrl("https://pub.example/a");
  assert.equal(got.tokenHeld, true);
  assert.equal(got.tokenFailure, undefined);
  assert.ok(net.asked.some((a) => a === "POST https://olp.example/api/token"));
  // …and it is now on the wire for any url that scope admits.
  assert.equal(licenseTokenFor("https://pub.example/anything"), "tok-abc");
  clearLicenseTokens();
});

test("a refused token names the server's own error code, so the right person fixes it", async () => {
  clearLicenseTokens();
  const net = serverSite({ status: 401, json: { error: "invalid_client" } });
  const r = makeLicenceResolver({
    fetcherFor: net.fetcherFor,
    licenseServers: () => ({ clientId: "id", clientSecret: "wrong" }),
  });
  const got = await r.forUrl("https://pub.example/a");
  assert.equal(got.tokenHeld, false);
  assert.match(got.tokenFailure ?? "", /invalid_client/);
  assert.equal(licenseTokenFor("https://pub.example/a"), null);
});

test("a held token short-circuits the round trip on the next url in the same scope", async () => {
  clearLicenseTokens();
  const net = serverSite({ json: { access_token: "tok-1", token_type: "License", expires_in: 0 } });
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor, licenseServers: () => ({ clientId: "i", clientSecret: "s" }) });
  await r.forUrl("https://pub.example/a");
  await r.forUrl("https://pub.example/b");
  assert.equal(net.asked.filter((a) => a.includes("/token")).length, 1, "a stranger's authorization endpoint is not a cache");
  clearLicenseTokens();
});

test("terms with no server have nothing to discharge and say so", async () => {
  const net = fakeNet(ROBOTS_SITE);
  const r = makeLicenceResolver({ fetcherFor: net.fetcherFor });
  const got = await r.forUrl("https://pub.example/a");
  assert.equal(got.terms?.obligation, "inline");
  assert.equal(got.tokenHeld, true);
});

test("with a signing identity, the /token request is signed over its own path so the key can be bound", async () => {
  clearLicenseTokens();
  process.env.BOT_AUTH_SIGNING_KEY = Buffer.alloc(32, 11).toString("base64url");
  process.env.BOT_AUTH_SIGNATURE_AGENT = "naulon.app";
  resetConfig();
  resetAgentIdentity();
  try {
    const net = serverSite({ json: { access_token: "tok-s", token_type: "License", expires_in: 60 } });
    const r = makeLicenceResolver({ fetcherFor: net.fetcherFor, licenseServers: () => ({ clientId: "i", clientSecret: "s" }) });
    await r.forUrl("https://pub.example/a");
    const h = net.tokenHeaders[0]!;
    assert.match(h["signature-input"] ?? "", /^sig1=\("@authority" "@path"\);/);
    assert.match(h["authorization"] ?? "", /^Basic /);
  } finally {
    delete process.env.BOT_AUTH_SIGNING_KEY;
    delete process.env.BOT_AUTH_SIGNATURE_AGENT;
    resetConfig();
    resetAgentIdentity();
    clearLicenseTokens();
  }
});

/* ── naulon's own licence server ─────────────────────────────────────────────────────────────── */

/** A site whose document names `server`, answering /token with a token. Records what was posted. */
function namedServerSite(server: string) {
  const asked: Array<{ line: string; headers: Record<string, string> }> = [];
  const doc = SERVER_DOC.replace('server="https://olp.example/api"', `server="${server}"`);
  const ok = (body: string) => ({ ok: true, status: 200, async text() { return body; }, async json() { return JSON.parse(body) as unknown; } });
  const fetcherFor = (_origin: string): Fetcher => async (url, init) => {
    asked.push({ line: `${init?.method ?? "GET"} ${url}`, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.endsWith("/robots.txt")) return ok("License: https://pub.example/license.xml");
    if (url.endsWith("/license.xml")) return ok(doc);
    if (url.endsWith("/token")) return ok(JSON.stringify({ access_token: "tok-n", token_type: "License", expires_in: 600 }));
    return { ok: false, status: 404, async text() { return ""; }, async json() { return null; } };
  };
  return { fetcherFor, asked };
}
const NAULON_SERVER = "https://gate.naulon.app/_naulon/olp/pub.example";

function agentToken(on: boolean): void {
  if (on) {
    process.env.NAULON_AGENT_TOKEN_ID = "agent-id-1";
    process.env.NAULON_AGENT_TOKEN = "nln_agent_secret";
  } else {
    delete process.env.NAULON_AGENT_TOKEN_ID;
    delete process.env.NAULON_AGENT_TOKEN;
  }
  resetConfig();
}

test("naulon's own licence server with no agent token: the page's x402 sale discharges it, and nothing is posted", async () => {
  clearLicenseTokens();
  agentToken(false);
  const net = namedServerSite(NAULON_SERVER);
  const got = await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("https://pub.example/a");
  assert.equal(got.tokenHeld, false);
  assert.equal(got.x402Discharges, true);
  assert.ok(!net.asked.some((a) => a.line.includes("/token")));
});

test("naulon's own licence server with an agent token configured: the licence is got with it", async () => {
  clearLicenseTokens();
  agentToken(true);
  try {
    const net = namedServerSite(NAULON_SERVER);
    const got = await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("https://pub.example/a");
    assert.equal(got.tokenHeld, true);
    const post = net.asked.find((a) => a.line === `POST ${NAULON_SERVER}/token`);
    assert.ok(post, "the per-site token endpoint was asked");
    assert.equal(post.headers["authorization"], `Basic ${Buffer.from("agent-id-1:nln_agent_secret").toString("base64")}`);
  } finally {
    agentToken(false);
    clearLicenseTokens();
  }
});

test("a server that only looks like naulon's never receives the agent token and gets no x402 pass", async () => {
  clearLicenseTokens();
  agentToken(true);
  try {
    const net = namedServerSite("https://gate.naulon.app.evil.example/_naulon/olp/pub.example");
    const got = await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("https://pub.example/a");
    assert.equal(got.tokenHeld, false);
    assert.equal(got.x402Discharges, undefined);
    assert.ok(!net.asked.some((a) => a.line.includes("/token")), "credentials go to naulon's origin and nowhere else");
  } finally {
    agentToken(false);
  }
});

test("isNaulonLicenceServer needs naulon's origin, the licence-server path AND the page's own site", () => {
  const page = "https://x.example/essays/a";
  assert.equal(isNaulonLicenceServer("https://gate.naulon.app/_naulon/olp/x.example", page), true);
  assert.equal(isNaulonLicenceServer("https://gate.naulon.app/_naulon/olp/other.example", page), false, "another site's server");
  assert.equal(isNaulonLicenceServer("https://gate.naulon.app/other", page), false);
  assert.equal(isNaulonLicenceServer("http://gate.naulon.app/_naulon/olp/x.example", page), false);
  assert.equal(isNaulonLicenceServer("not a url", page), false);
});

test("a document naming ANOTHER site's naulon licence server gets no agent token and no x402 pass", async () => {
  clearLicenseTokens();
  agentToken(true);
  try {
    const net = namedServerSite("https://gate.naulon.app/_naulon/olp/other.example");
    const got = await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("https://pub.example/a");
    assert.equal(got.x402Discharges, undefined);
    assert.ok(!net.asked.some((a) => a.line.includes("/token")));
  } finally {
    agentToken(false);
  }
});

test("the gate this agent pays is not trusted with the agent token", async () => {
  clearLicenseTokens();
  agentToken(true);
  process.env.TOLLGATE_URL = "https://someones-gate.example";
  resetConfig();
  try {
    const net = namedServerSite("https://someones-gate.example/_naulon/olp/pub.example");
    await makeLicenceResolver({ fetcherFor: net.fetcherFor }).forUrl("https://pub.example/a");
    assert.ok(!net.asked.some((a) => a.line.includes("/token")));
  } finally {
    delete process.env.TOLLGATE_URL;
    agentToken(false);
  }
});
