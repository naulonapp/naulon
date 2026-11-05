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
  seenRecorder,
  SEEN_EVERY_MS,
  sweepConnect,
  SWEEP_EVERY_MS,
} from "./grants.ts";
import { checkChallenge, clientResolver, parseClientMetadata } from "./client.ts";

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
  assert.deepEqual(await redeemCode(store, presented(code), 2001), { ok: false, error: "invalid_grant", reason: "code already used" });
  assert.deepEqual(await redeemCode(store, presented("nln_code_" + "x".repeat(43)), 2002), { ok: false, error: "invalid_grant", reason: "unknown or used code" });
});

test("a code carries an embedder's context to its redemption, untouched", async () => {
  const store = memoryStateStore();
  const code = await saveCode(store, { ...pending, context: { tenantId: "t_123", userId: "u_9" } });
  const r = await redeemCode(store, presented(code));
  assert.equal(r.ok, true);
  assert.deepEqual((r as { code: { context?: Record<string, string> } }).code.context, { tenantId: "t_123", userId: "u_9" });
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
  assert.equal(await revokeCredentialById(store, "../x"), null);
  assert.equal((await revokeCredentialById(store, id))?.site, pending.site);
  assert.equal(await revokeCredentialById(store, id), null, "a second revoke finds nothing");
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

test("saving a code sweeps dead ones, at most once per window", async () => {
  const store = memoryStateStore();
  const dead = await saveCode(store, pending, 0); // first save sweeps an empty store at t=0
  await redeemCode(store, presented(dead), 1);
  const within = SWEEP_EVERY_MS - 1;
  await saveCode(store, pending, within);
  assert.equal((await store.list("connect.used:")).length, 1, "inside the window nothing is swept");
  await saveCode(store, pending, SWEEP_EVERY_MS + CODE_TTL_MS);
  assert.equal((await store.list("connect.used:")).length, 0, "past it, the stale marker is gone");
  assert.equal((await store.list("connect.code:")).length, 1, "the code saved inside the window expired too; only the newest is left");
});

test("a sweep that fails does not fail the approval", async () => {
  const store = memoryStateStore();
  const broken = { ...store, kind: store.kind, list: async () => Promise.reject(new Error("store down")) };
  const warned: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    assert.match(await saveCode(broken, pending, 0), /^nln_code_/);
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
});

test("last use is recorded beside the credential, throttled, and goes with it on revoke", async () => {
  const store = memoryStateStore();
  const cred = await issueCredential(store, { site: pending.site, clientId: pending.clientId, clientName: "WordPress", approvedBy: "owner" });
  assert.equal((await listCredentials(store))[0]!.lastSeenAt, null, "never used reads as never");

  let t = 5_000;
  const seen = seenRecorder(store, { now: () => t });
  seen(cred);
  await new Promise((r) => setImmediate(r));
  assert.equal((await listCredentials(store))[0]!.lastSeenAt, 5_000);
  t += SEEN_EVERY_MS - 1;
  seen(cred);
  await new Promise((r) => setImmediate(r));
  assert.equal((await listCredentials(store))[0]!.lastSeenAt, 5_000, "inside the window the store is not written");
  t += 1;
  seen(cred);
  await new Promise((r) => setImmediate(r));
  assert.equal((await listCredentials(store))[0]!.lastSeenAt, 5_000 + SEEN_EVERY_MS);

  const id = (await listCredentials(store))[0]!.id;
  assert.notEqual(await revokeCredentialById(store, id), null);
  assert.deepEqual(await store.list("connect.seen:"), []);
});

test("a use recorded after a revoke cannot bring the credential back", async () => {
  const store = memoryStateStore();
  const cred = await issueCredential(store, { site: pending.site, clientId: pending.clientId, clientName: "WordPress", approvedBy: "owner" });
  await revokeCredential(store, cred);
  seenRecorder(store)(cred); // the request that resolved it just before the revoke, finishing late
  await new Promise((r) => setImmediate(r));
  assert.equal(await resolveCredential(store, cred), null);
  assert.deepEqual(await listCredentials(store), []);
  assert.equal(await sweepConnect(store), 1, "the stray last-seen is swept");
  assert.deepEqual(await store.list("connect.seen:"), []);
});

test("a failed last-seen write is retried on the next use and warned once", async () => {
  const store = memoryStateStore();
  let fail = true;
  const flaky = { ...store, kind: store.kind, put: async (k: string, v: string) => (fail ? Promise.reject(new Error("down")) : store.put(k, v)) };
  const cred = await issueCredential(store, { site: pending.site, clientId: pending.clientId, clientName: "WordPress", approvedBy: "owner" });
  const warnings: string[] = [];
  const seen = seenRecorder(flaky, { now: () => 1, warn: (m) => void warnings.push(m) });
  seen(cred);
  await new Promise((r) => setImmediate(r));
  seen(cred);
  await new Promise((r) => setImmediate(r));
  assert.equal(warnings.length, 1);
  fail = false;
  seen(cred);
  await new Promise((r) => setImmediate(r));
  assert.equal((await listCredentials(store))[0]!.lastSeenAt, 1);
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
});

test("a client may only send the owner back to its own origin, exactly", () => {
  const id = `${site}/.well-known/naulon-client`;
  for (const r of ["http://127.0.0.1/callback", "http://localhost:8080/callback", "https://evil.example.net/cb", "http://blog.example.com/cb"]) {
    assert.equal(parseClientMetadata(doc({ redirect_uris: [r] }), id).ok, false, r);
  }
  const local = "http://127.0.0.1:8080";
  assert.equal(parseClientMetadata({ ...doc(), client_id: `${local}/.well-known/naulon-client`, redirect_uris: [`${local}/cb`] }, `${local}/.well-known/naulon-client`).ok, true, "a local walk on this machine");
  assert.equal(redirectMatches(`${site}/cb`, `${site}/cb`), true);
  assert.equal(redirectMatches("http://127.0.0.1:1/cb", "http://127.0.0.1:2/cb"), false, "no port leeway");
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
