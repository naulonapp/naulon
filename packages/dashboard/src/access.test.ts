import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAccess, isLoopbackBind } from "./access.ts";
import { isLoopbackHostname } from "./host-guard.ts";

test("loopback bind → private, full ops, no auth", () => {
  for (const bind of ["127.0.0.1", "::1", "localhost"]) {
    const d = decideAccess({ bind, auth: undefined, isPublic: false });
    assert.equal(d.serve, true);
    assert.equal(d.mode, "private");
    assert.equal(d.requireAuth, false);
    assert.equal(d.refuse, false);
  }
});

test("wide bind + auth → authed, full ops, basic auth enforced", () => {
  const d = decideAccess({ bind: "0.0.0.0", auth: "admin:secret", isPublic: false });
  assert.equal(d.serve, true);
  assert.equal(d.mode, "authed");
  assert.equal(d.requireAuth, true);
  assert.equal(d.refuse, false);
});

test("wide bind + public → public earnings only, no auth", () => {
  const d = decideAccess({ bind: "0.0.0.0", auth: undefined, isPublic: true });
  assert.equal(d.serve, true);
  assert.equal(d.mode, "public");
  assert.equal(d.requireAuth, false);
});

test("wide bind, no auth, not public → REFUSE (fail safe, don't leak wallets)", () => {
  const d = decideAccess({ bind: "0.0.0.0", auth: undefined, isPublic: false });
  assert.equal(d.serve, false);
  assert.equal(d.refuse, true);
  assert.match(d.reason, /DASHBOARD_AUTH|DASHBOARD_PUBLIC/);
});

test("0.0.0.0 is treated as wide, never loopback", () => {
  const d = decideAccess({ bind: "0.0.0.0", auth: undefined, isPublic: false });
  assert.equal(d.mode, "refused");
});

test("a public loopback bind stays private-capable but honours the public flag", () => {
  // Even on loopback, an explicit public flag serves the public view (a hoster
  // testing the shareable page locally before exposing it).
  const d = decideAccess({ bind: "127.0.0.1", auth: undefined, isPublic: true });
  assert.equal(d.serve, true);
  assert.equal(d.mode, "public");
});

test("auth string must be user:pass to count", () => {
  const d = decideAccess({ bind: "0.0.0.0", auth: "nopassword", isPublic: false });
  assert.equal(d.refuse, true); // malformed auth is no auth
});

// ── Reach is not the same thing as bind ──────────────────────────────────────────
// A loopback bind used to be proof of privacy. It isn't: serverless never binds, so
// the 127.0.0.1 default survived while the console answered the public internet, and
// the only thing standing between that and a wallet leak was the operator declining
// to follow the host guard's own instructions.

test("loopback bind + a non-loopback allowed host + no auth → REFUSE", () => {
  const d = decideAccess({
    bind: "127.0.0.1",
    auth: undefined,
    isPublic: false,
    allowedHosts: ["dash.example.com"],
  });
  assert.equal(d.serve, false);
  assert.equal(d.mode, "refused");
  // The remedy must name the real cause, not "bind 127.0.0.1" — which is already true.
  assert.match(d.reason, /dash\.example\.com/);
  assert.match(d.reason, /DASHBOARD_AUTH/);
});

test("loopback bind + a non-loopback allowed host + auth → authed", () => {
  const d = decideAccess({
    bind: "127.0.0.1",
    auth: "admin:secret",
    isPublic: false,
    allowedHosts: ["dash.example.com"],
  });
  assert.equal(d.serve, true);
  assert.equal(d.mode, "authed");
  assert.equal(d.requireAuth, true);
  assert.match(d.reason, /dash\.example\.com/);
});

test("loopback bind + a non-loopback allowed host + public → the masked page, no auth", () => {
  const d = decideAccess({
    bind: "127.0.0.1",
    auth: undefined,
    isPublic: true,
    allowedHosts: ["dash.example.com"],
  });
  assert.equal(d.mode, "public");
});

test("allowing only loopback aliases keeps private mode", () => {
  const d = decideAccess({
    bind: "127.0.0.1",
    auth: undefined,
    isPublic: false,
    allowedHosts: ["localhost", "127.0.0.1", "::1"],
  });
  assert.equal(d.mode, "private");
  assert.equal(d.requireAuth, false);
});

test("no allowed hosts at all behaves exactly as before", () => {
  const bare = decideAccess({ bind: "127.0.0.1", auth: undefined, isPublic: false });
  const empty = decideAccess({
    bind: "127.0.0.1",
    auth: undefined,
    isPublic: false,
    allowedHosts: [],
  });
  assert.equal(bare.mode, "private");
  assert.deepEqual(bare, empty);
});

test("the serverless shape: nothing binds, so bind reads loopback while a public host is served", () => {
  // What DEPLOY.md §3 produces on Vercel: DASHBOARD_BIND untouched at its default,
  // and the operator names their real hostname to get past the Host guard. Before
  // this rule that combination served the full ops console — wallets, earnings,
  // config, webhook URLs — to anyone who could resolve the name.
  const d = decideAccess({
    bind: "127.0.0.1",
    auth: undefined,
    isPublic: false,
    allowedHosts: ["dash.naulon.app"],
  });
  assert.equal(d.serve, false);
  assert.equal(d.requireAuth, false); // refused outright, not "served behind auth"
});

// ── An explicit credential is never discarded ────────────────────────────────────
// The loopback shortcut used to be checked first, so a console started WITH a
// credential ran with none, and the boot line said `[private]`. Loopback is not a
// trust boundary on a box with more than one user reaching 127.0.0.1.

test("loopback bind + a valid credential → authed, not private", () => {
  for (const bind of ["127.0.0.1", "::1", "localhost"]) {
    const d = decideAccess({ bind, auth: "admin:secret", isPublic: false });
    assert.equal(d.mode, "authed", `${bind} must not discard DASHBOARD_AUTH`);
    assert.equal(d.requireAuth, true);
    assert.equal(d.serve, true);
    assert.equal(d.refuse, false);
  }
});

test("the authed reason names the loopback bind rather than an empty host list", () => {
  const d = decideAccess({ bind: "127.0.0.1", auth: "admin:secret", isPublic: false });
  assert.match(d.reason, /loopback bind \(127\.0\.0\.1\) with DASHBOARD_AUTH set/);
  assert.doesNotMatch(d.reason, /reachable as +with/, "no dangling host list");
});

test("a malformed credential on loopback still yields private, not a broken authed", () => {
  // Nothing to enforce: basicAuth would be mounted with an empty password.
  const d = decideAccess({ bind: "127.0.0.1", auth: "nopassword", isPublic: false });
  assert.equal(d.mode, "private");
  assert.equal(d.requireAuth, false);
});

test("the public flag still wins over a credential", () => {
  // DASHBOARD_PUBLIC is itself an explicit choice, and the page it serves is masked.
  const d = decideAccess({ bind: "127.0.0.1", auth: "admin:secret", isPublic: true });
  assert.equal(d.mode, "public");
  assert.equal(d.requireAuth, false);
});

test("a bind and a Host header answer 'is this loopback' differently, on purpose", () => {
  // 0.0.0.0 is every interface when you BIND it and a local name when it arrives in a
  // Host header. Unifying the two sets would either read a wide bind as private (the
  // wallet leak) or refuse a legitimate local request, so this pins the divergence.
  assert.equal(isLoopbackBind("0.0.0.0"), false, "binding every interface is not private");
  assert.equal(isLoopbackHostname("0.0.0.0"), true, "but it is a local name in a Host header");
  for (const both of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(isLoopbackBind(both), true);
    assert.equal(isLoopbackHostname(both), true);
  }
});
