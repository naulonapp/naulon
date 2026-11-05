import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDiscovery, originOf, parseDiscovery } from "./discovery.ts";
import {
  authorizationUrl,
  codeChallengeOf,
  credentialDigest,
  isSiteCredential,
  mintSiteCredential,
  newState,
  newVerifier,
  parseAuthorizationRequest,
  siteOriginOf,
} from "./flow.ts";

const fixtures = JSON.parse(readFileSync(new URL("./connect.fixtures.json", import.meta.url), "utf8")) as {
  pkce: { verifier: string; challenge: string }[];
  siteOrigins: { input: string; origin: string | null }[];
  discovery: { gate: string; body: unknown; ok: boolean; error?: string }[];
};

test("a gate's own document reads back for that gate", () => {
  const doc = buildDiscovery({ issuer: "https://gate.example.com/" });
  const r = parseDiscovery(JSON.parse(JSON.stringify(doc)), "https://gate.example.com");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.doc.enforce_api, "https://gate.example.com/_naulon");
});

test("a document is refused for any gate but its issuer", () => {
  const doc = buildDiscovery({ issuer: "https://gate.example.com" });
  const r = parseDiscovery(doc, "https://other.example.com");
  assert.deepEqual(r, { ok: false, error: "issuer https://gate.example.com does not match https://other.example.com" });
});

test("approval may live on another origin, a runtime's credentials may not", () => {
  const hosted = buildDiscovery({ issuer: "https://gate.example.com", authorizationEndpoint: "https://portal.example.com/connect" });
  assert.equal(parseDiscovery(hosted, "https://gate.example.com").ok, true);
  const moved = { ...hosted, token_endpoint: "https://evil.example.net/token" };
  assert.deepEqual(parseDiscovery(moved, "https://gate.example.com"), { ok: false, error: "token_endpoint is not on https://gate.example.com" });
});

test("http is a gate on this machine or nothing", () => {
  assert.equal(originOf("http://127.0.0.1:8402/x"), "http://127.0.0.1:8402");
  assert.equal(originOf("http://localhost:8402"), "http://localhost:8402");
  assert.equal(originOf("http://gate.example.com"), null);
  assert.equal(originOf("https://user:pw@gate.example.com"), null);
  assert.throws(() => buildDiscovery({ issuer: "http://gate.example.com" }));
});

test("discovery fixtures, shared with the Python and PHP runtimes", () => {
  for (const f of fixtures.discovery) {
    const r = parseDiscovery(f.body, f.gate);
    assert.equal(r.ok, f.ok, `${f.gate}: ${JSON.stringify(r)}`);
    if (!r.ok && f.error) assert.match(r.error, new RegExp(f.error));
  }
});

test("S256 matches RFC 7636 appendix B and the shared fixtures", () => {
  assert.equal(codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  for (const f of fixtures.pkce) assert.equal(codeChallengeOf(f.verifier), f.challenge);
  assert.throws(() => codeChallengeOf("short"));
});

test("a site is an origin and nothing more", () => {
  for (const f of fixtures.siteOrigins) assert.equal(siteOriginOf(f.input), f.origin, f.input);
});

test("credentials are recognisable, random, and stored only as a digest", () => {
  const a = mintSiteCredential();
  const b = mintSiteCredential();
  assert.equal(isSiteCredential(a), true);
  assert.notEqual(a, b);
  assert.equal(isSiteCredential(`${a}x`), false);
  assert.equal(isSiteCredential("nln_live_" + a.slice(9)), false);
  assert.match(credentialDigest(a), /^[0-9a-f]{64}$/);
});

test("an authorization request survives the round trip, and each defect is named", () => {
  const verifier = newVerifier();
  const request = {
    clientId: "https://naulon.app/clients/wordpress.json",
    redirectUri: "https://blog.example.com/wp-admin/admin.php?page=naulon&connect=return",
    site: "https://blog.example.com",
    state: newState(),
    codeChallenge: codeChallengeOf(verifier),
  };
  const url = new URL(authorizationUrl("https://gate.example.com/connect/authorize", request));
  assert.deepEqual(parseAuthorizationRequest(url.searchParams), { ok: true, request });

  const broken = (key: string, value: string | null) => {
    const p = new URLSearchParams(url.searchParams);
    if (value === null) p.delete(key);
    else p.set(key, value);
    const r = parseAuthorizationRequest(p);
    assert.equal(r.ok, false, `${key}=${value}`);
    return r.ok ? "" : r.error;
  };
  assert.equal(broken("response_type", "token"), "unsupported_response_type");
  assert.equal(broken("code_challenge_method", "plain"), "code_challenge_method must be S256");
  assert.equal(broken("scope", "site.enforce account:write"), "invalid_scope");
  assert.match(broken("client_id", "wordpress"), /client_id/);
  assert.match(broken("site", "https://blog.example.com/blog"), /site must be an origin/);
  assert.match(broken("state", "short"), /state/);
  assert.match(broken("state", "../../../etc/passwd/aaaaaaaaaaaa"), /state/);
  assert.match(broken("code_challenge", "x"), /code_challenge/);
  assert.match(broken("redirect_uri", null), /redirect_uri/);
});
