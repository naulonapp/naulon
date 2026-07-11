import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAccess } from "./access.ts";

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
