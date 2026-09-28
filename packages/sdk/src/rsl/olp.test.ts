import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher } from "../crawl/types.ts";
import { acquireLicenseToken, introspectLicence, licenceServerUrlOk, olpRetryable, tokenEndpoint } from "./olp.ts";

const CREDS = { clientId: "agent-1", clientSecret: "s3cret" };

/** Records what was actually sent, because the wire shape IS the contract here. */
function fakeServer(reply: { status?: number; json?: unknown; text?: string }) {
  const sent: Array<{ origin: string; url: string; init: unknown }> = [];
  const fetcherFor = (origin: string): Fetcher => async (url, init) => {
    sent.push({ origin, url, init });
    const status = reply.status ?? 200;
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return body; },
      async json() { return JSON.parse(body) as unknown; },
    };
  };
  return { fetcherFor, sent };
}

test("the token endpoint is JOINED to the server path, never substituted for it", () => {
  // `new URL("/token", base)` would turn https://example-server.org/api into
  // https://example-server.org/token — our client credentials POSTed at the wrong path.
  assert.equal(tokenEndpoint("https://example-server.org/api"), "https://example-server.org/api/token");
  assert.equal(tokenEndpoint("https://example-server.org"), "https://example-server.org/token");
  assert.equal(tokenEndpoint("https://example-server.org/api/"), "https://example-server.org/api/token");
});

test("a licence server must be https — it carries client secrets", () => {
  assert.equal(tokenEndpoint("http://example-server.org/api"), null);
  assert.equal(tokenEndpoint("not a url"), null);
});

test("the request is exactly what the spec asks for", async () => {
  const net = fakeServer({ json: { access_token: "tok-1", token_type: "License", expires_in: 3600 } });
  const r = await acquireLicenseToken({
    server: "https://olp.example/api",
    licenseXml: "<license><permits type=\"usage\">ai-input</permits></license>",
    resource: "/articles/*",
    credentials: CREDS,
    fetcherFor: net.fetcherFor,
    now: () => 1_000_000,
  });
  assert.equal(r.ok, true);

  const call = net.sent[0]!;
  assert.equal(call.url, "https://olp.example/api/token");
  assert.equal(call.origin, "https://olp.example", "the guarded fetcher must be built for the SERVER's origin");
  const init = call.init as { method: string; body: string; headers: Record<string, string> };
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(init.headers["authorization"], `Basic ${Buffer.from("agent-1:s3cret").toString("base64")}`);
  const form = new URLSearchParams(init.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("resource"), "/articles/*");
  assert.equal(form.get("license"), '<license><permits type="usage">ai-input</permits></license>');
});

test("expires_in becomes a deadline; 0 and absent both mean it never expires", async () => {
  const at = async (expires_in: unknown) => {
    const net = fakeServer({ json: { access_token: "t", token_type: "License", expires_in } });
    const r = await acquireLicenseToken({
      server: "https://olp.example",
      licenseXml: "<license/>",
      resource: "/",
      credentials: CREDS,
      fetcherFor: net.fetcherFor,
      now: () => 1_000_000,
    });
    assert.equal(r.ok, true);
    return r.ok ? r.token : null;
  };
  assert.equal((await at(3600))!.expiresAt, 1_000_000 + 3_600_000);
  assert.equal((await at(0))!.expiresAt, null);
  assert.equal((await at(undefined))!.expiresAt, null);
  assert.equal((await at(-5))!.expiresAt, null, "a negative lifetime is not a token that expired in the past");
});

test("each spec error code survives, because they call for different actions", async () => {
  const cases: Array<[number, string]> = [
    [400, "invalid_request"],
    [400, "invalid_license"],
    [400, "invalid_resource"],
    [400, "unsupported_grant_type"],
    [401, "invalid_client"],
    [401, "unauthorized_client"],
    [500, "server_error"],
  ];
  for (const [status, code] of cases) {
    const net = fakeServer({ status, json: { error: code, error_description: "because" } });
    const r = await acquireLicenseToken({
      server: "https://olp.example",
      licenseXml: "<license/>",
      resource: "/",
      credentials: CREDS,
      fetcherFor: net.fetcherFor,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.failure.code, code);
    assert.equal(r.ok === false && r.failure.status, status);
    assert.equal(r.ok === false && r.failure.description, "because");
  }
});

test("an error code the spec does not define is `malformed`, not trusted", async () => {
  const net = fakeServer({ status: 400, json: { error: "pay_us_more" } });
  const r = await acquireLicenseToken({
    server: "https://olp.example", licenseXml: "<license/>", resource: "/", credentials: CREDS, fetcherFor: net.fetcherFor,
  });
  assert.equal(r.ok === false && r.failure.code, "malformed");
});

test("a 200 with no access_token is malformed — never a token of empty string", async () => {
  for (const json of [{}, { access_token: "", token_type: "License" }, { access_token: "t" }]) {
    const net = fakeServer({ json });
    const r = await acquireLicenseToken({
      server: "https://olp.example", licenseXml: "<license/>", resource: "/", credentials: CREDS, fetcherFor: net.fetcherFor,
    });
    assert.equal(r.ok, false, JSON.stringify(json));
    assert.equal(r.ok === false && r.failure.code, "malformed");
  }
});

test("HTML from a licence server is reported as malformed, not as a parse crash", async () => {
  const net = fakeServer({ text: "<html>login</html>" });
  const r = await acquireLicenseToken({
    server: "https://olp.example", licenseXml: "<license/>", resource: "/", credentials: CREDS, fetcherFor: net.fetcherFor,
  });
  assert.equal(r.ok === false && r.failure.code, "malformed");
  assert.equal(r.ok === false && r.failure.description, "response was not JSON");
});

test("an unreachable server is a distinct outcome from a refusal", async () => {
  const thrower = (): Fetcher => async () => {
    throw new Error("ETIMEDOUT");
  };
  const r = await acquireLicenseToken({
    server: "https://olp.example", licenseXml: "<license/>", resource: "/", credentials: CREDS, fetcherFor: thrower,
  });
  assert.equal(r.ok === false && r.failure.code, "unreachable");
  assert.equal(r.ok === false && r.failure.status, 0);
});

test("only a server error or an unreachable server is worth retrying", () => {
  // Retrying invalid_client hammers a stranger's authorization endpoint with credentials it has
  // already rejected — the fastest way to get an operator's whole fleet blocked.
  assert.equal(olpRetryable({ code: "server_error", status: 500 }), true);
  assert.equal(olpRetryable({ code: "unreachable", status: 0 }), true);
  for (const code of ["invalid_client", "unauthorized_client", "invalid_license", "invalid_resource", "invalid_request", "unsupported_grant_type", "malformed"] as const) {
    assert.equal(olpRetryable({ code, status: 400 }), false, code);
  }
});

test("extraHeaders reach the POST, and can never replace the credentials or the content type", async () => {
  const net = fakeServer({ json: { access_token: "tok-1", token_type: "License", expires_in: 60 } });
  await acquireLicenseToken({
    server: "https://olp.example/api",
    licenseXml: "<license/>",
    resource: "https://pub.example/a",
    credentials: CREDS,
    fetcherFor: net.fetcherFor,
    extraHeaders: {
      "signature-input": "sig1=x",
      signature: "sig1=:y:",
      Authorization: "Bearer stolen",
      "content-type": "text/plain",
    },
  });
  const init = net.sent[0]!.init as { headers: Record<string, string> };
  assert.equal(init.headers["signature-input"], "sig1=x");
  assert.equal(init.headers["signature"], "sig1=:y:");
  assert.equal(init.headers["authorization"], `Basic ${Buffer.from("agent-1:s3cret").toString("base64")}`);
  assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(Object.keys(init.headers).filter((k) => k.toLowerCase() === "authorization").length, 1);
  assert.equal(Object.keys(init.headers).filter((k) => k.toLowerCase() === "content-type").length, 1);
});

test("a licence server URL is https, or http only on a loopback host", () => {
  assert.equal(licenceServerUrlOk("https://ls.example/olp"), true);
  assert.equal(licenceServerUrlOk("http://127.0.0.1:11100/_naulon/olp"), true);
  assert.equal(licenceServerUrlOk("http://localhost:11100/olp"), true);
  assert.equal(licenceServerUrlOk("http://[::1]/olp"), true);
  assert.equal(licenceServerUrlOk("http://ls.example/olp"), false);
  assert.equal(licenceServerUrlOk("http://127.0.0.1.evil.example/olp"), false);
  assert.equal(licenceServerUrlOk("ftp://ls.example"), false);
  assert.equal(licenceServerUrlOk("not a url"), false);
});

/* ── introspect: a self-hosted origin asks whether a presented licence permits this read ── */

function introspectServer(reply: { status?: number; json?: unknown; text?: string; throws?: boolean }) {
  const sent: Array<{ url: string; init: { method?: string; body?: string; headers?: Record<string, string> } }> = [];
  const fetcher: Fetcher = async (url, init) => {
    sent.push({ url, init: init ?? {} });
    if (reply.throws) throw new Error("connect ECONNREFUSED");
    const status = reply.status ?? 200;
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return { ok: status >= 200 && status < 300, status, async text() { return body; }, async json() { return JSON.parse(body) as unknown; } };
  };
  return { fetcher, sent };
}
const INTROSPECT = { server: "https://ls.example/olp", token: "olp_t", resource: "https://pub.example/a", slug: "a", kind: "read" as const, apiKey: "nln_live_k" };

test("introspect posts every field the server needs, the signature only when there is one", async () => {
  const net = introspectServer({ json: { active: true, permitted: true, license_jws: "jws", charged_micro: "11000" } });
  const r = await introspectLicence({ ...INTROSPECT, fetcher: net.fetcher, userAgent: "AgentBot/2.0", signature: { input: "sig1=(…)", signature: "sig1=:x:", agent: '"naulon.app"' } });
  assert.deepEqual(r, { ok: true, active: true, permitted: true, licenseJws: "jws", chargedMicro: "11000" });
  const call = net.sent[0]!;
  assert.equal(call.url, "https://ls.example/olp/introspect");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.["authorization"], "Bearer nln_live_k");
  assert.equal(call.init.headers?.["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(call.init.body);
  assert.deepEqual(Object.fromEntries(form), {
    token: "olp_t", resource: "https://pub.example/a", slug: "a", kind: "read", user_agent: "AgentBot/2.0",
    signature_input: "sig1=(…)", signature: "sig1=:x:", signature_agent: '"naulon.app"',
  });
  const bare = introspectServer({ json: { active: false } });
  await introspectLicence({ ...INTROSPECT, fetcher: bare.fetcher });
  assert.equal(new URLSearchParams(bare.sent[0]!.init.body).has("signature"), false);
});

test("introspect: an inactive token and a refused read are answers, not failures", async () => {
  assert.deepEqual(await introspectLicence({ ...INTROSPECT, fetcher: introspectServer({ json: { active: false } }).fetcher }), {
    ok: true, active: false, permitted: false,
  });
  const refused = await introspectLicence({
    ...INTROSPECT,
    fetcher: introspectServer({ json: { active: true, permitted: false, error: "signature_required", reason: "sign it" } }).fetcher,
  });
  assert.deepEqual(refused, { ok: true, active: true, permitted: false, error: "signature_required", reason: "sign it" });
});

test("introspect: a non-2xx, HTML, a thrown fetch or an http server is ok:false, never permitted", async () => {
  const bad = await introspectLicence({ ...INTROSPECT, fetcher: introspectServer({ status: 401, json: { error: "invalid_client" } }).fetcher });
  assert.equal(bad.ok, false);
  assert.equal((await introspectLicence({ ...INTROSPECT, fetcher: introspectServer({ text: "<html>" }).fetcher })).ok, false);
  assert.equal((await introspectLicence({ ...INTROSPECT, fetcher: introspectServer({ throws: true }).fetcher })).ok, false);
  const plain = introspectServer({ json: { active: true, permitted: true } });
  assert.equal((await introspectLicence({ ...INTROSPECT, server: "http://ls.example/olp", fetcher: plain.fetcher })).ok, false);
  assert.equal(plain.sent.length, 0, "a token is never sent to a plain-http licence server");
});

test("introspect: permitted is only true when the server says both active and permitted", async () => {
  const r = await introspectLicence({ ...INTROSPECT, fetcher: introspectServer({ json: { active: false, permitted: true } }).fetcher });
  assert.equal(r.ok && r.permitted, false);
});
