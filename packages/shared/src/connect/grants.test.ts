import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryStateStore } from "../state/store.ts";
import { codeChallengeOf, newVerifier, redirectMatches } from "./flow.ts";
import {
  CODE_TTL_MS,
  issueCredential,
  listCredentials,
  redeemCode,
  resolveCredential,
  revokeCredential,
  revokeCredentialById,
  saveCode,
  sweepConnect,
} from "./grants.ts";
import { checkChallenge, CLI_CLIENT_ID, clientResolver, parseClientMetadata, redirectAllowed } from "./client.ts";

const verifier = newVerifier();
const pending = {
  clientId: "https://blog.example.com/.well-known/naulon-client",
  clientName: "WordPress on blog.example.com",
  redirectUri: "https://blog.example.com/wp-admin/admin.php?page=naulon&connect=return",
  site: "https://blog.example.com",
  codeChallenge: codeChallengeOf(verifier),
  approvedBy: "owner",
};
const presented = (code: string, over: Partial<{ codeVerifier: string; redirectUri: string; clientId: string }> = {}) => ({
  code,
  codeVerifier: verifier,
  redirectUri: pending.redirectUri,
  clientId: pending.clientId,
  ...over,
});

test("a code redeems once, for its client, redirect and verifier", async () => {
  const store = memoryStateStore();
  const code = await saveCode(store, pending, 1000);
  const r = await redeemCode(store, presented(code), 2000);
  assert.equal(r.ok, true);
  assert.deepEqual(await redeemCode(store, presented(code), 2001), { ok: false, error: "invalid_grant", reason: "unknown or used code" });
});

test("each defect in a token request is refused, and the refusal burns the code", async () => {
  const store = memoryStateStore();
  const cases: [Partial<{ codeVerifier: string; redirectUri: string; clientId: string }>, string, string][] = [
    [{ codeVerifier: newVerifier() }, "invalid_grant", "code_verifier does not match"],
    [{ codeVerifier: "short" }, "invalid_grant", "malformed code_verifier"],
    [{ redirectUri: "https://blog.example.com/other" }, "invalid_grant", "redirect_uri does not match"],
    [{ clientId: "https://evil.example.net/.well-known/naulon-client" }, "invalid_client", "code was issued to another client"],
  ];
  for (const [over, error, reason] of cases) {
    const code = await saveCode(store, pending);
    assert.deepEqual(await redeemCode(store, presented(code, over)), { ok: false, error, reason });
    assert.equal((await redeemCode(store, presented(code))).ok, false, `${reason}: the honest retry must not succeed after a bad one`);
  }
});

test("an expired code is refused", async () => {
  const store = memoryStateStore();
  const code = await saveCode(store, pending, 0);
  assert.deepEqual(await redeemCode(store, presented(code), CODE_TTL_MS), { ok: false, error: "invalid_grant", reason: "code expired" });
});

test("twenty racing redemptions of one code: exactly one wins", async () => {
  const store = memoryStateStore();
  const code = await saveCode(store, pending);
  const results = await Promise.all(Array.from({ length: 20 }, () => redeemCode(store, presented(code))));
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("a loopback redirect matches on any port, nothing else does", () => {
  assert.equal(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:53111/callback"), true);
  assert.equal(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:53111/other"), false);
  assert.equal(redirectMatches("http://127.0.0.1/callback?a=1", "http://127.0.0.1:53111/callback?a=2"), false);
  assert.equal(redirectMatches("https://a.example.com/cb", "https://a.example.com:8443/cb"), false);
  assert.equal(redirectMatches("http://127.0.0.1/callback", "http://localhost:5000/callback"), false);
  assert.equal(redirectMatches("http://a.example.com/cb", "http://a.example.com:81/cb"), false);
});

test("a credential resolves until revoked, by value or by id, and only a digest is stored", async () => {
  const store = memoryStateStore();
  const cred = await issueCredential(store, { site: pending.site, clientId: pending.clientId, clientName: "WordPress", approvedBy: "owner" }, 5);
  assert.equal((await resolveCredential(store, cred))?.site, "https://blog.example.com");
  const rows = await store.list("");
  assert.equal(rows.some((r) => r.key.includes(cred) || r.value.includes(cred)), false);
  const [listed] = await listCredentials(store);
  assert.equal(listed?.hint, cred.slice(-4));
  await revokeCredential(store, cred);
  assert.equal(await resolveCredential(store, cred), null);

  const second = await issueCredential(store, { site: pending.site, clientId: pending.clientId, clientName: "WordPress", approvedBy: "owner" });
  const id = (await listCredentials(store))[0]!.id;
  assert.equal(await revokeCredentialById(store, "../x"), false);
  assert.equal(await revokeCredentialById(store, id), true);
  assert.equal(await resolveCredential(store, second), null);
  await revokeCredential(store, "nln_site_unknown"); // RFC 7009: never an error
});

test("the sweep drops expired codes and old markers, and keeps live ones", async () => {
  const store = memoryStateStore();
  const live = await saveCode(store, pending, 1_000_000);
  const dead = await saveCode(store, pending, 0);
  await redeemCode(store, presented(dead), 1); // leaves a marker at t=1
  assert.equal(await sweepConnect(store, CODE_TTL_MS + 2), 1);
  assert.equal((await store.list("connect.code:")).length, 1);
  assert.equal((await redeemCode(store, presented(live), 1_000_001)).ok, true);
});

const site = "https://blog.example.com";
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: `${site}/.well-known/naulon-client`,
  client_name: "WordPress on blog.example.com",
  redirect_uris: [`${site}/wp-admin/admin.php?page=naulon&connect=return`],
  ...over,
});

test("a client document is accepted only when it names itself and redirects home", () => {
  const id = `${site}/.well-known/naulon-client`;
  assert.equal(parseClientMetadata(doc(), id).ok, true);
  assert.match((parseClientMetadata(doc({ client_id: "https://other.example.com/x" }), id) as { error: string }).error, /different client_id/);
  assert.match((parseClientMetadata(doc({ redirect_uris: ["https://evil.example.net/cb"] }), id) as { error: string }).error, /not on https:\/\/blog.example.com/);
  assert.match((parseClientMetadata(doc({ redirect_uris: [`${site}/cb#frag`] }), id) as { error: string }).error, /not on/);
  assert.match((parseClientMetadata(doc({ client_name: "" }), id) as { error: string }).error, /client_name/);
  assert.match((parseClientMetadata(doc({ grant_types: ["client_credentials"] }), id) as { error: string }).error, /authorization_code/);
  assert.equal(parseClientMetadata(doc({ redirect_uris: ["http://127.0.0.1/callback"] }), id).ok, true);
});

test("the command-line client resolves without a single network call", async () => {
  let fetched = 0;
  const r = await clientResolver({ fetch: async () => (fetched++, { ok: false, refusal: "unreachable", detail: "offline" }) }).resolve(CLI_CLIENT_ID);
  assert.equal(r.ok, true);
  assert.equal(fetched, 0);
  assert.equal(r.ok && redirectAllowed(r.client, "http://127.0.0.1:61234/callback"), true);
  assert.equal(r.ok && redirectAllowed(r.client, "https://evil.example.net/callback"), false);
});

test("a client document is cached for its max-age, within 5 minutes and a day", async () => {
  let fetched = 0;
  let t = 0;
  const resolver = clientResolver({
    now: () => t,
    fetch: async () => (fetched++, { ok: true, status: 200, body: JSON.stringify(doc()), contentType: "application/json", cacheControl: "max-age=10", headers: {} }),
  });
  const id = `${site}/.well-known/naulon-client`;
  await resolver.resolve(id);
  t = 299_000;
  await resolver.resolve(id);
  assert.equal(fetched, 1, "max-age=10 is raised to the 5 minute floor");
  t = 301_000;
  await resolver.resolve(id);
  assert.equal(fetched, 2);
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

test("the challenge passes only when the site answers this connect's challenge", async () => {
  const challenge = codeChallengeOf(verifier);
  const state = "s".repeat(32);
  const s = await serve((req, res) => {
    if (req.url === `/.well-known/naulon-challenge/${state}`) return res.end(`${challenge}\n`);
    res.writeHead(404).end();
  });
  try {
    assert.deepEqual(await checkChallenge(s.url, state, challenge, { allowPrivate: true }), { ok: true });
    assert.match(((await checkChallenge(s.url, "t".repeat(32), challenge, { allowPrivate: true })) as { reason: string }).reason, /answered 404/);
    assert.match(((await checkChallenge(s.url, state, codeChallengeOf(newVerifier()), { allowPrivate: true })) as { reason: string }).reason, /did not answer this connect/);
    assert.match(((await checkChallenge(s.url, state, challenge)) as { reason: string }).reason, /could not be reached/);
  } finally {
    await s.close();
  }
});
