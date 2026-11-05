import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  codeChallengeOf,
  memoryStateStore,
  newVerifier,
  parseDiscovery,
  resolveCredential,
  saveCode,
  type PublisherConfig,
  type PublisherResolver,
} from "@naulon/shared";
import { mountGateConnect, REVOKE_PATH, TOKEN_PATH } from "./routes.ts";
import { siteCredentialAuth } from "./auth.ts";

const SITE = "https://blog.example.com";
const CLIENT = `${SITE}/.well-known/naulon-client`;
const REDIRECT = `${SITE}/wp-admin/admin.php?page=naulon&connect=return`;

function gate(publicUrl?: string) {
  const state = memoryStateStore();
  const app = new Hono();
  mountGateConnect(app, {
    state,
    ...(publicUrl ? { publicUrl } : {}),
    authorizeUrl: "https://console.example.com/connect/authorize",
    trustProxy: true,
    proxyHops: 1,
  });
  return { app, state };
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function approved(state: ReturnType<typeof memoryStateStore>) {
  const verifier = newVerifier();
  const code = await saveCode(state, { clientId: CLIENT, clientName: "WordPress", redirectUri: REDIRECT, site: SITE, codeChallenge: codeChallengeOf(verifier), approvedBy: "owner" });
  return { code, verifier };
}

test("discovery names this gate, read back by the same parser every runtime uses", async () => {
  const { app } = gate();
  const res = await app.request("https://gate.example.com/.well-known/naulon", { headers: { host: "gate.example.com", "x-forwarded-proto": "https" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const r = parseDiscovery(await res.json(), "https://gate.example.com");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.doc.authorization_endpoint, "https://console.example.com/connect/authorize");
  assert.equal(r.ok && r.doc.token_endpoint, `https://gate.example.com${TOKEN_PATH}`);
});

test("a configured public URL is the issuer whatever Host the request carries", async () => {
  const { app } = gate("https://gate.example.com");
  const res = await app.request("http://10.0.0.5:8402/.well-known/naulon", { headers: { host: "10.0.0.5:8402" } });
  assert.equal((await res.json() as { issuer: string }).issuer, "https://gate.example.com");
});

test("an approved code becomes a site credential once, with no-store and no refresh token", async () => {
  const { app, state } = gate();
  const { code, verifier } = await approved(state);
  const res = await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: CLIENT }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as Record<string, string>;
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "scope", "site", "token_type"]);
  assert.equal(body.site, SITE);
  assert.equal((await resolveCredential(state, body.access_token!))?.clientName, "WordPress");

  const replay = await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: CLIENT }));
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
});

test("the token endpoint refuses each malformed request with its own message", async () => {
  const { app, state } = gate();
  const { code, verifier } = await approved(state);
  const json = await app.request(TOKEN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(((await json.json()) as { error: string }).error, "invalid_request");
  const grant = await app.request(TOKEN_PATH, form({ grant_type: "client_credentials" }));
  assert.equal(((await grant.json()) as { error: string }).error, "unsupported_grant_type");
  const missing = await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code }));
  assert.match(((await missing.json()) as { error_description: string }).error_description, /required/);
  const wrongClient = await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: "https://evil.example.net/c" }));
  assert.equal(wrongClient.status, 401);
  const big = await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code: "x".repeat(9000) }));
  assert.equal(big.status, 400);
});

test("revocation ends a credential and answers 200 for one that never existed", async () => {
  const { app, state } = gate();
  const { code, verifier } = await approved(state);
  const token = ((await (await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: CLIENT }))).json()) as { access_token: string }).access_token;
  assert.equal((await app.request(REVOKE_PATH, form({ token }))).status, 200);
  assert.equal(await resolveCredential(state, token), null);
  assert.equal((await app.request(REVOKE_PATH, form({ token: "nln_site_nothing" }))).status, 200);
  assert.equal((await app.request(REVOKE_PATH, form({}))).status, 400);
});

const resolver: PublisherResolver = { resolve: async () => ({ id: "default" }) as PublisherConfig };

async function credentialFor(state: ReturnType<typeof memoryStateStore>, site = SITE) {
  const { app } = { app: new Hono() };
  mountGateConnect(app, { state, authorizeUrl: "https://c.example.com/connect/authorize", trustProxy: false, proxyHops: 1 });
  const verifier = newVerifier();
  const code = await saveCode(state, { clientId: CLIENT, clientName: "WordPress", redirectUri: REDIRECT, site, codeChallenge: codeChallengeOf(verifier), approvedBy: "owner" });
  return ((await (await app.request(TOKEN_PATH, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: CLIENT }))).json()) as { access_token: string }).access_token;
}

function ctx(authorization?: string) {
  return { req: { header: (n: string) => (n === "authorization" ? authorization : undefined) } } as unknown as Parameters<ReturnType<typeof siteCredentialAuth>>[0];
}

test("a site credential acts for its own host and nowhere else", async () => {
  const state = memoryStateStore();
  const cred = await credentialFor(state);
  const auth = siteCredentialAuth({ state, resolver });
  assert.deepEqual(await auth(ctx(`Bearer ${cred}`), "blog.example.com"), { ok: true, publisherId: "default", selfHosted: true });
  assert.deepEqual(await auth(ctx(`Bearer ${cred}`), "other.example.com"), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(await auth(ctx(`Bearer ${cred}`), "blog.example.com:8443"), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(await auth(ctx(`Bearer ${cred}x`), "blog.example.com"), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(await auth(ctx(), "blog.example.com"), { ok: false, status: 401, error: "unauthorized" });
});

test("a revoked credential stops at once, and the legacy operator key keeps working beside it", async () => {
  const state = memoryStateStore();
  const cred = await credentialFor(state);
  const legacyKey = "k".repeat(40);
  const auth = siteCredentialAuth({ state, resolver, legacyKey });
  assert.equal((await auth(ctx(`Bearer ${legacyKey}`), "blog.example.com")).ok, true);
  await state.delete((await state.list("credential:"))[0]!.key);
  assert.equal((await auth(ctx(`Bearer ${cred}`), "blog.example.com")).ok, false);
});
