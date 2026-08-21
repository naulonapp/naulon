import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { hashPassword } from "./credential.ts";
import { createMemoryStore, emptyState, type ConsoleRole, type ConsoleState } from "./console-store.ts";
import { memoryAuditor } from "./console-audit.ts";
import { consoleAuth, mountConsoleAuth, requireRole, type ConsoleAuthDeps } from "./console-auth.ts";
import { DEFAULT_LIFETIMES } from "./console-session.ts";

/** Generated per run, never a literal: nothing here may depend on a particular value. */
const PASSPHRASE = `pw-${randomBytes(9).toString("hex")}`;
const MACHINE_KEY = `mk-${randomBytes(9).toString("hex")}`;
/** Minted once at a cheap work factor — these tests exercise the flow, not the KDF. */
const HASH = await hashPassword(PASSPHRASE, { ln: 10, r: 8, p: 1 });

const ORIGIN = "http://console.test";
const HOST = "console.test";

const user = (id: string, username: string, role: ConsoleRole, extra: Record<string, unknown> = {}) => ({
  id,
  username,
  passwordHash: HASH,
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
  passwordChangedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

interface Harness {
  app: Hono;
  deps: ConsoleAuthDeps;
  auditor: ReturnType<typeof memoryAuditor>;
}

function harness(opts: {
  users?: ConsoleState["users"];
  machine?: { role: ConsoleRole } | null;
  privateMode?: boolean;
  loopbackOnly?: boolean;
}): Harness {
  const store = createMemoryStore({ ...emptyState(), users: opts.users ?? [] });
  const auditor = memoryAuditor();
  const deps: ConsoleAuthDeps = {
    store,
    auditor,
    lifetimes: DEFAULT_LIFETIMES,
    machine: opts.machine
      ? { username: "ops", role: opts.machine.role, verify: (u, p) => u === "ops" && p === MACHINE_KEY }
      : null,
    loopbackOnly: opts.loopbackOnly ?? true,
    privateMode: opts.privateMode ?? false,
  };
  const app = new Hono();
  app.use("*", consoleAuth(deps));
  mountConsoleAuth(app, deps);
  app.get("/", (c) => c.text("ops console"));
  app.get("/api/ledger", (c) => c.json({ ok: true }));
  app.post("/api/test-toll", requireRole("admin"), (c) => c.text("fired"));
  return { app, deps, auditor };
}

const nav = { "Sec-Fetch-Mode": "navigate", Host: HOST };
const machineAuth = { Authorization: `Basic ${Buffer.from(`ops:${MACHINE_KEY}`).toString("base64")}` };
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: HOST },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: Harness, username = "alice"): Promise<string> {
  const res = await h.app.request("/login", form({ username, password: PASSPHRASE }));
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = /naulon_console=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token, `no session cookie in ${res.status} ${setCookie}`);
  return `naulon_console=${token}`;
}

// ── The default console must not change ──────────────────────────────────────────

test("a private console with no accounts still serves, with no login at all", async () => {
  const h = harness({ privateMode: true });
  assert.equal((await h.app.request("/", { headers: nav })).status, 200);
  assert.equal((await h.app.request("/api/ledger")).status, 200);
  // And the writes still work — this is the `make dev` console, unchanged.
  assert.equal((await h.app.request("/api/test-toll", { method: "POST", headers: { Host: HOST } })).status, 200);
});

test("LEGACY: DASHBOARD_AUTH with no accounts behaves exactly as it did — browsers included", async () => {
  const h = harness({ machine: { role: "viewer" }, privateMode: false });
  const anon = await h.app.request("/", { headers: nav });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /^Basic/, "the browser must still be prompted");

  const authed = await h.app.request("/", { headers: { ...nav, ...machineAuth } });
  assert.equal(authed.status, 200, "an upgrade must not make a working console dark");
  // Even though the credential's role is `viewer`, in legacy there are no accounts for it
  // to be a viewer NEXT to — it is still the whole login, so it still writes.
  const write = await h.app.request("/api/test-toll", { method: "POST", headers: { Host: HOST, ...machineAuth } });
  assert.equal(write.status, 200);
});

// ── Once accounts exist ──────────────────────────────────────────────────────────

test("with accounts, an anonymous browser is sent to the login page and an API call gets 401", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const page = await h.app.request("/", { headers: nav });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login?next=%2F");

  const api = await h.app.request("/api/ledger", { headers: { Host: HOST } });
  assert.equal(api.status, 401, "a script gets a status, not a redirect to HTML");
});

test("signing in issues a session that then works", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const cookie = await signIn(h);
  const res = await h.app.request("/", { headers: { ...nav, Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ops console");
  assert.equal(h.auditor.entries.filter((e) => e.action === "console.sign_in" && e.outcome === "ok").length, 1);
});

test("a wrong password answers 401 — the failed-sign-in budget charges by status", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", form({ username: "alice", password: "not-it" }));
  assert.equal(res.status, 401, "a 200 here would disarm authThrottle entirely");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(h.auditor.entries.at(-1)?.outcome, "failed");
});

test("an unknown username is refused the same way a wrong password is", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", form({ username: "nobody", password: PASSPHRASE }));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Wrong username or password/, "never 'no such user' — that is an enumeration oracle");
});

test("a disabled account cannot sign in, even with the right password", async () => {
  const h = harness({ users: [user("u1", "alice", "admin", { disabledAt: "2026-02-01T00:00:00.000Z" })] });
  const res = await h.app.request("/login", form({ username: "alice", password: PASSPHRASE }));
  assert.equal(res.status, 401);
});

// ── The two credentials are not equals ───────────────────────────────────────────

test("once accounts exist, the machine credential answers APIs but is refused for navigation", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")], machine: { role: "viewer" } });
  assert.equal((await h.app.request("/api/ledger", { headers: { Host: HOST, ...machineAuth } })).status, 200);

  const page = await h.app.request("/", { headers: { ...nav, ...machineAuth } });
  assert.equal(page.status, 401);
  const body = await page.text();
  assert.match(body, /machine credential/);
  assert.match(body, /\/login/, "the refusal has to say what to do instead");
});

test("the machine credential is a VIEWER by default — it reads the ledger, it does not fire a toll", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")], machine: { role: "viewer" } });
  const res = await h.app.request("/api/test-toll", { method: "POST", headers: { Host: HOST, ...machineAuth } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /DASHBOARD_AUTH_ROLE=admin/, "the refusal names the exact remedy");
});

test("DASHBOARD_AUTH_ROLE=admin lets the machine credential write", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")], machine: { role: "admin" } });
  const res = await h.app.request("/api/test-toll", { method: "POST", headers: { Host: HOST, ...machineAuth } });
  assert.equal(res.status, 200);
});

test("a signed-in VIEWER may read but not run an ops write", async () => {
  const h = harness({ users: [user("u2", "vic", "viewer")] });
  const cookie = await signIn(h, "vic");
  assert.equal((await h.app.request("/api/ledger", { headers: { Host: HOST, Cookie: cookie } })).status, 200);
  const write = await h.app.request("/api/test-toll", {
    method: "POST",
    headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie },
  });
  assert.equal(write.status, 403);
  assert.match(await write.text(), /viewer/);
});

test("a session beats a machine credential presented on the same request", async () => {
  // Otherwise a browser that had signed in would be silently downgraded to the machine
  // credential's viewer role by an Authorization header it happens to carry.
  const h = harness({ users: [user("u1", "alice", "admin")], machine: { role: "viewer" } });
  const cookie = await signIn(h);
  const res = await h.app.request("/api/test-toll", {
    method: "POST",
    headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie, ...machineAuth },
  });
  assert.equal(res.status, 200);
});

// ── CSRF ─────────────────────────────────────────────────────────────────────────

test("a sign-in POST with no Origin is refused — a cookie-setting request is not a script's", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Host: HOST },
    body: new URLSearchParams({ username: "alice", password: PASSPHRASE }).toString(),
  });
  assert.equal(res.status, 403);
});

test("a cross-origin sign-in POST is refused", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://evil.example", Host: HOST },
    body: new URLSearchParams({ username: "alice", password: PASSPHRASE }).toString(),
  });
  assert.equal(res.status, 403);
});

test("an admin form POST from another origin cannot add an operator", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const cookie = await signIn(h);
  const res = await h.app.request("/account/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://evil.example",
      Host: HOST,
      Cookie: cookie,
    },
    body: new URLSearchParams({ username: "mallory", password: PASSPHRASE, role: "admin" }).toString(),
  });
  assert.equal(res.status, 403);
  assert.equal((await h.deps.store.read()).users.length, 1);
});

// ── Logout, forced password change, redirects ────────────────────────────────────

test("logout destroys the session server-side and the old cookie stops working", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const cookie = await signIn(h);
  const out = await h.app.request("/logout", {
    method: "POST",
    headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie },
  });
  assert.equal(out.status, 303);
  assert.equal((await h.deps.store.read()).sessions.length, 0);

  const after = await h.app.request("/", { headers: { ...nav, Cookie: cookie } });
  assert.equal(after.status, 302, "a destroyed session must not still open the console");
  assert.equal(h.auditor.entries.filter((e) => e.action === "console.sign_out").length, 1);
});

test("a seeded account must change its password before the console renders anything", async () => {
  const h = harness({ users: [user("u1", "admin", "admin", { mustChangePassword: true })] });
  const cookie = await signIn(h, "admin");
  const page = await h.app.request("/", { headers: { ...nav, Cookie: cookie } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/account/password");

  assert.equal((await h.app.request("/api/ledger", { headers: { Host: HOST, Cookie: cookie } })).status, 403);
  // ...but the route that lets them fix it is reachable.
  assert.equal((await h.app.request("/account/password", { headers: { ...nav, Cookie: cookie } })).status, 200);
});

test("changing a password revokes every OTHER session for that account", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const laptop = await signIn(h);
  const phone = await signIn(h);
  assert.equal((await h.deps.store.read()).sessions.length, 2);

  const fresh = `pw-${randomBytes(9).toString("hex")}`;
  const res = await h.app.request("/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: HOST, Cookie: phone },
    body: new URLSearchParams({ current: PASSPHRASE, password: fresh, repeat: fresh }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal((await h.deps.store.read()).sessions.length, 1, "one session survives: the one that changed it");
  assert.equal((await h.app.request("/", { headers: { ...nav, Cookie: laptop } })).status, 302);
  assert.match(res.headers.get("set-cookie") ?? "", /naulon_console=/, "and it is re-minted, not reused");
});

test("changing a password requires the CURRENT one, even with a valid session", async () => {
  // A borrowed unlocked browser must not become a permanent takeover.
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const cookie = await signIn(h);
  const fresh = `pw-${randomBytes(9).toString("hex")}`;
  const res = await h.app.request("/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: HOST, Cookie: cookie },
    body: new URLSearchParams({ current: "guessing", password: fresh, repeat: fresh }).toString(),
  });
  assert.match(res.headers.get("location") ?? "", /error=/);
});

test("the `next` parameter cannot be turned into an open redirect", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", form({ username: "alice", password: PASSPHRASE, next: "//evil.example/" }));
  assert.equal(res.headers.get("location"), "/", "a protocol-relative next must be dropped, not followed");
});

test("a same-site next IS honoured", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/login", form({ username: "alice", password: PASSPHRASE, next: "/traffic" }));
  assert.equal(res.headers.get("location"), "/traffic");
});

// ── First-run ────────────────────────────────────────────────────────────────────

test("first-run setup is open on a loopback console with no accounts", async () => {
  const h = harness({ privateMode: true, loopbackOnly: true });
  assert.equal((await h.app.request("/setup", { headers: nav })).status, 200);
});

test("first-run setup is CLOSED to a stranger on a reachable console", async () => {
  // The failure this prevents: whoever finds the console first becomes its administrator.
  const h = harness({ loopbackOnly: false, machine: { role: "viewer" } });
  const res = await h.app.request("/setup", { headers: nav });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /loopback/);
});

test("first-run setup is closed once an administrator exists", async () => {
  const h = harness({ users: [user("u1", "alice", "admin")], privateMode: true });
  assert.equal((await h.app.request("/setup", { headers: nav })).status, 403);
});

test("creating the first administrator signs them straight in", async () => {
  const h = harness({ privateMode: true, loopbackOnly: true });
  const res = await h.app.request("/setup", form({ username: "alice", password: PASSPHRASE, repeat: PASSPHRASE }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie") ?? "", /naulon_console=/);
  const state = await h.deps.store.read();
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0]?.role, "admin");
  assert.equal(
    h.auditor.entries.some((e) => e.action === "console.bootstrap"),
    true,
  );
});

test("the stylesheet the login page needs is reachable without a session", async () => {
  // Otherwise the sign-in page renders unstyled for exactly the people who cannot sign in.
  const h = harness({ users: [user("u1", "alice", "admin")] });
  const res = await h.app.request("/auth.css", { headers: { Host: HOST } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/css/);
});
