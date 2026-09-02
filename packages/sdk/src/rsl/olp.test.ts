import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher } from "../crawl/types.ts";
import { acquireLicenseToken, olpRetryable, tokenEndpoint } from "./olp.ts";

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
