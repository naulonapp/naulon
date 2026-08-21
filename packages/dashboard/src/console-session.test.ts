import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, emptyState, type ConsoleState } from "./console-store.ts";
import {
  clearSessionCookies,
  cookieNameFor,
  createSession,
  destroySession,
  destroyUserSessions,
  hashToken,
  isSecureRequest,
  resolveSession,
  sessionCookie,
  tokenFromCookieHeader,
} from "./console-session.ts";

const LIFETIMES = { idleMs: 1000, absoluteMs: 5000 };

function storeWith(users: ConsoleState["users"]) {
  return createMemoryStore({ ...emptyState(), users });
}

const alice = {
  id: "u1",
  username: "alice",
  passwordHash: "$scrypt$x",
  role: "admin" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  passwordChangedAt: "2026-01-01T00:00:00.000Z",
};

test("the token is never stored — only its digest is", async () => {
  const store = storeWith([alice]);
  const { token } = await createSession(store, "u1");
  const state = await store.read();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0]?.tokenHash, hashToken(token));
  assert.notEqual(state.sessions[0]?.tokenHash, token);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(token.slice(0, 20)), "the raw token must not appear anywhere");
});

test("session tokens carry far more than OWASP's 64-bit floor, and never repeat", async () => {
  const store = storeWith([alice]);
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { token } = await createSession(store, "u1");
    // base64url of 32 bytes — 256 bits.
    assert.ok(token.length >= 43, `token too short: ${token.length}`);
    assert.equal(seen.has(token), false);
    seen.add(token);
  }
});

test("a live session resolves to its user", async () => {
  const store = storeWith([alice]);
  const { token } = await createSession(store, "u1");
  const found = await resolveSession(store, token, LIFETIMES);
  assert.equal(found.ok, true);
  assert.equal(found.ok && found.value.user.username, "alice");
});

test("an unknown or absent token is refused, and is distinguishable in the reason", async () => {
  const store = storeWith([alice]);
  assert.deepEqual(await resolveSession(store, undefined, LIFETIMES), { ok: false, reason: "absent" });
  assert.deepEqual(await resolveSession(store, "not-a-token", LIFETIMES), { ok: false, reason: "unknown" });
});

test("the IDLE window expires a session, and the expired record is deleted, not left to rot", async () => {
  const store = storeWith([alice]);
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const now = () => new Date(clock);
  const { token } = await createSession(store, "u1", { now });

  clock += 999;
  assert.equal((await resolveSession(store, token, LIFETIMES, now)).ok, true);

  clock += 2000; // past idleMs since the last touch
  assert.deepEqual(await resolveSession(store, token, LIFETIMES, now), { ok: false, reason: "expired" });
  assert.equal((await store.read()).sessions.length, 0, "an expired session must be removed");
});

test("the ABSOLUTE window ends a session that has never been idle", async () => {
  const store = storeWith([alice]);
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const now = () => new Date(clock);
  const { token } = await createSession(store, "u1", { now });

  // Stay active well inside the idle window, so only the absolute ceiling can end it.
  for (let i = 0; i < 5; i++) {
    clock += 900;
    assert.equal((await resolveSession(store, token, LIFETIMES, now)).ok, true, `live at ${i}`);
  }
  clock += 900; // 5400 ms old — past absoluteMs, still well inside idleMs
  assert.deepEqual(await resolveSession(store, token, LIFETIMES, now), { ok: false, reason: "expired" });
  assert.equal((await store.read()).sessions.length, 0);
});

test("an idle window shorter than the touch floor still refreshes — the floor scales to it", async () => {
  // The trap this guards: a flat 60 s floor with a 1-minute idle window means the anchor is
  // never refreshed before the session has already died, so an actively-used console signs
  // the operator out on a timer while every log looks healthy.
  const store = storeWith([alice]);
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const now = () => new Date(clock);
  const short = { idleMs: 1000, absoluteMs: 60_000 };
  const { token } = await createSession(store, "u1", { now });
  for (let i = 0; i < 10; i++) {
    clock += 900;
    assert.equal((await resolveSession(store, token, short, now)).ok, true, `still live at ${i}`);
  }
});

test("the idle anchor is not rewritten on every request — there is a touch floor", async () => {
  const store = storeWith([alice]);
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const now = () => new Date(clock);
  const generous = { idleMs: 10 * 60_000, absoluteMs: 60 * 60_000 };
  const { token } = await createSession(store, "u1", { now });
  const first = (await store.read()).sessions[0]?.lastSeenAt;

  clock += 5_000; // under the 60 s floor
  await resolveSession(store, token, generous, now);
  assert.equal((await store.read()).sessions[0]?.lastSeenAt, first, "a 5 s-old anchor must not be rewritten");

  clock += 120_000; // over it
  await resolveSession(store, token, generous, now);
  assert.notEqual((await store.read()).sessions[0]?.lastSeenAt, first);
});

test("a disabled account's live session stops resolving", async () => {
  const store = storeWith([{ ...alice, disabledAt: "2026-02-01T00:00:00.000Z" }]);
  const { token } = await createSession(store, "u1");
  assert.deepEqual(await resolveSession(store, token, LIFETIMES), { ok: false, reason: "disabled" });
  assert.equal((await store.read()).sessions.length, 0);
});

test("logout destroys the record server-side, not just the cookie", async () => {
  const store = storeWith([alice]);
  const { token } = await createSession(store, "u1");
  await destroySession(store, token);
  assert.equal((await store.read()).sessions.length, 0);
  assert.deepEqual(await resolveSession(store, token, LIFETIMES), { ok: false, reason: "unknown" });
});

test("destroyUserSessions clears every session but the one it is told to keep", async () => {
  const store = storeWith([alice, { ...alice, id: "u2", username: "bob" }]);
  const keep = await createSession(store, "u1");
  await createSession(store, "u1");
  await createSession(store, "u1");
  const other = await createSession(store, "u2");

  await destroyUserSessions(store, "u1", keep.token);
  const state = await store.read();
  assert.equal(state.sessions.filter((s) => s.userId === "u1").length, 1);
  assert.equal((await resolveSession(store, keep.token, LIFETIMES)).ok, true);
  assert.equal((await resolveSession(store, other.token, LIFETIMES)).ok, true, "another account is untouched");
});

test("the cookie carries __Host- and Secure only where they can work", () => {
  const secure = sessionCookie("tok", { secure: true });
  assert.match(secure, /^__Host-naulon_console=tok;/);
  assert.match(secure, /; Secure/);
  assert.match(secure, /; HttpOnly/);
  assert.match(secure, /; SameSite=Strict/);
  assert.match(secure, /; Path=\//);
  assert.doesNotMatch(secure, /Domain=/, "a Domain attribute would widen it to sibling subdomains");

  // Plain http (the loopback console): the prefix REQUIRES Secure, and a Secure cookie is
  // not universally accepted over http — so both are dropped together, never one of them.
  const plain = sessionCookie("tok", { secure: false });
  assert.match(plain, /^naulon_console=tok;/);
  assert.doesNotMatch(plain, /Secure/);
  assert.equal(cookieNameFor(false), "naulon_console");
});

test("logout expires BOTH cookie spellings — a console that gained TLS still signs out", () => {
  const cleared = clearSessionCookies(false);
  assert.equal(cleared.length, 2);
  assert.ok(cleared.some((c) => c.startsWith("__Host-naulon_console=") && c.includes("Secure")));
  assert.ok(cleared.some((c) => c.startsWith("naulon_console=")));
  assert.ok(cleared.every((c) => c.includes("Max-Age=0")));
});

test("the cookie is read whichever spelling the browser holds, and ordering does not matter", () => {
  assert.equal(tokenFromCookieHeader("naulon_console=abc"), "abc");
  assert.equal(tokenFromCookieHeader("other=1; __Host-naulon_console=xyz; z=2"), "xyz");
  assert.equal(tokenFromCookieHeader("unrelated=1"), undefined);
  assert.equal(tokenFromCookieHeader(undefined), undefined);
});

test("a proxied https origin is detected, and a plain loopback one is not", () => {
  assert.equal(isSecureRequest("http://127.0.0.1:8403/", "https"), true, "Caddy on :443 → loopback");
  assert.equal(isSecureRequest("http://127.0.0.1:8403/", "https, http"), true, "first hop wins");
  assert.equal(isSecureRequest("http://127.0.0.1:8403/", undefined), false);
  assert.equal(isSecureRequest("https://console.example/", undefined), true);
});
