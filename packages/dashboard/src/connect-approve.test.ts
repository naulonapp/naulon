import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import {
  authorizationUrl,
  codeChallengeOf,
  memoryStateStore,
  newState,
  newVerifier,
  redeemCode,
  type ClientResolver,
} from "@naulon/shared";
import { AUTHORIZE_PATH, mountConnectApprove } from "./connect-approve.ts";

async function site(answers: Map<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const state = req.url?.replace("/.well-known/naulon-challenge/", "") ?? "";
    const value = answers.get(state);
    if (value) return res.end(value);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** A client that serves its own metadata from the site, like the WordPress plugin does. */
function clientsFor(siteUrl: string, name = "WordPress on this site"): ClientResolver {
  return {
    resolve: async (clientId) =>
      clientId === `${siteUrl}/.well-known/naulon-client`
        ? { ok: true, client: { clientId, origin: siteUrl, name, redirectUris: [`${siteUrl}/wp-admin/admin.php?page=naulon&connect=return`] } }
        : { ok: false, error: "unknown client" },
  };
}

function consoleApp(siteUrl: string, signedIn: { role: "admin" | "viewer" } | null) {
  const state = memoryStateStore();
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (signedIn) c.set("naulonPrincipal" as never, { kind: "session", username: "ops", userId: "u1", role: signedIn.role, mustChangePassword: false } as never);
    await next();
  });
  mountConnectApprove(app, { state, clients: clientsFor(siteUrl), allowLoopback: true, gateLabel: "gate.example.com" });
  return { app, state };
}

function request(siteUrl: string) {
  const verifier = newVerifier();
  const state = newState();
  const params = {
    clientId: `${siteUrl}/.well-known/naulon-client`,
    redirectUri: `${siteUrl}/wp-admin/admin.php?page=naulon&connect=return`,
    site: siteUrl,
    state,
    codeChallenge: codeChallengeOf(verifier),
  };
  const url = new URL(authorizationUrl(`http://console.test${AUTHORIZE_PATH}`, params));
  return { verifier, state, params, url };
}

const post = (fields: URLSearchParams, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...extra },
  body: fields.toString(),
});

test("the owner sees the site, the proof it answered, and what the connection can and cannot do", async () => {
  const answers = new Map<string, string>();
  const s = await site(answers);
  try {
    const r = request(s.url);
    answers.set(r.state, r.params.codeChallenge);
    const { app } = consoleApp(s.url, { role: "admin" });
    const res = await app.request(r.url.pathname + r.url.search);
    assert.equal(res.status, 200);
    const html = await res.text();
    const host = new URL(s.url).host;
    assert.match(html, new RegExp(`<title>Connect ${host} · naulon</title>`));
    assert.match(html, /answered this request just now/);
    assert.match(html, /WordPress on this site <span>\(its own description\)<\/span>/);
    assert.match(html, /It cannot/);
    assert.match(html, /name="decision" value="approve">Approve</);
    assert.match(html, /name="decision" value="deny" class="secondary">Deny</);
    assert.equal(html.includes("<script"), false);
  } finally {
    await s.close();
  }
});

test("Approve sends back a code the gate redeems, and only for this request's verifier", async () => {
  const answers = new Map<string, string>();
  const s = await site(answers);
  try {
    const r = request(s.url);
    answers.set(r.state, r.params.codeChallenge);
    const { app, state } = consoleApp(s.url, { role: "admin" });
    const fields = new URLSearchParams(r.url.searchParams);
    fields.set("decision", "approve");
    const res = await app.request(AUTHORIZE_PATH, post(fields));
    assert.equal(res.status, 303);
    const back = new URL(res.headers.get("location")!);
    assert.equal(back.origin + back.pathname, `${s.url}/wp-admin/admin.php`);
    assert.equal(back.searchParams.get("state"), r.state);
    const code = back.searchParams.get("code")!;
    const redeemed = await redeemCode(state, { code, codeVerifier: r.verifier, redirectUri: r.params.redirectUri, clientId: r.params.clientId });
    assert.equal(redeemed.ok, true);
    assert.equal(redeemed.ok && redeemed.code.approvedBy, "ops");
  } finally {
    await s.close();
  }
});

test("a site that does not answer this connect is never approved", async () => {
  const answers = new Map<string, string>();
  const s = await site(answers);
  try {
    const r = request(s.url);
    answers.set(r.state, codeChallengeOf(newVerifier())); // answers, but for a different connect
    const { app, state } = consoleApp(s.url, { role: "admin" });
    const shown = await app.request(r.url.pathname + r.url.search);
    assert.equal(shown.status, 409);
    assert.match(await shown.text(), /did not answer this connect/);
    const fields = new URLSearchParams(r.url.searchParams);
    fields.set("decision", "approve");
    assert.equal((await app.request(AUTHORIZE_PATH, post(fields))).status, 409);
    assert.deepEqual(await state.list("connect.code:"), []);
  } finally {
    await s.close();
  }
});

test("Deny goes back with access_denied, even when the site has stopped answering", async () => {
  const s = await site(new Map());
  try {
    const r = request(s.url);
    const { app, state } = consoleApp(s.url, { role: "admin" });
    const fields = new URLSearchParams(r.url.searchParams);
    fields.set("decision", "deny");
    const res = await app.request(AUTHORIZE_PATH, post(fields));
    assert.equal(res.status, 303);
    const back = new URL(res.headers.get("location")!);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), r.state);
    assert.deepEqual(await state.list("connect.code:"), []);
  } finally {
    await s.close();
  }
});

test("a request this console cannot trust to redirect gets a page here and is never sent back", async () => {
  const s = await site(new Map());
  try {
    const { app } = consoleApp(s.url, { role: "admin" });
    const evil = request(s.url);
    evil.url.searchParams.set("redirect_uri", "https://evil.example.net/steal");
    const res = await app.request(evil.url.pathname + evil.url.search);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /not from the app it names/);

    const unknown = request(s.url);
    unknown.url.searchParams.set("client_id", "https://nobody.example.com/.well-known/naulon-client");
    assert.equal((await app.request(unknown.url.pathname + unknown.url.search)).status, 400);

    const fields = new URLSearchParams(evil.url.searchParams);
    fields.set("decision", "deny");
    const denied = await app.request(AUTHORIZE_PATH, post(fields));
    assert.equal(denied.status, 400, "Deny must not become an open redirect either");
  } finally {
    await s.close();
  }
});

test("a viewer cannot approve, and a cross-site form post is refused", async () => {
  const answers = new Map<string, string>();
  const s = await site(answers);
  try {
    const r = request(s.url);
    answers.set(r.state, r.params.codeChallenge);
    const viewer = consoleApp(s.url, { role: "viewer" });
    assert.equal((await viewer.app.request(r.url.pathname + r.url.search)).status, 403);

    const admin = consoleApp(s.url, { role: "admin" });
    const fields = new URLSearchParams(r.url.searchParams);
    fields.set("decision", "approve");
    const forged = await admin.app.request(AUTHORIZE_PATH, post(fields, { "sec-fetch-site": "cross-site" }));
    assert.equal(forged.status, 403);
    assert.deepEqual(await admin.state.list("connect.code:"), []);
  } finally {
    await s.close();
  }
});

test("signed out, nobody approves", async () => {
  const s = await site(new Map());
  try {
    const r = request(s.url);
    const { app } = consoleApp(s.url, null);
    assert.equal((await app.request(r.url.pathname + r.url.search)).status, 401);
  } finally {
    await s.close();
  }
});
