import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedHost, parseAllowedHosts } from "./host-guard.ts";

const LOOPBACK_OK = [
  "127.0.0.1:8403",
  "127.0.0.1",
  "localhost:8403",
  "localhost",
  "[::1]:8403",
  "[::1]",
  "0.0.0.0:8403", // the bind itself, when an operator points a browser at it
];

test("loopback hosts are always allowed in private mode", () => {
  for (const h of LOOPBACK_OK) {
    assert.equal(isAllowedHost(h, [], "private"), true, `${h} should be allowed`);
  }
});

test("a foreign Host is refused in private mode — this is the rebinding defense", () => {
  assert.equal(isAllowedHost("evil.com", [], "private"), false);
  assert.equal(isAllowedHost("evil.com:8403", [], "private"), false);
  // The attack shape: a hostname the attacker controls, pointed at 127.0.0.1.
  assert.equal(isAllowedHost("rebind.attacker.test:8403", [], "private"), false);
});

test("an operator-declared host is allowed, port-insensitively", () => {
  const allowed = parseAllowedHosts("ops.example.com, dash.internal");
  assert.equal(isAllowedHost("ops.example.com", allowed, "private"), true);
  assert.equal(isAllowedHost("ops.example.com:443", allowed, "private"), true);
  assert.equal(isAllowedHost("dash.internal:8403", allowed, "private"), true);
  assert.equal(isAllowedHost("other.example.com", allowed, "private"), false);
});

test("host matching is case-insensitive (Host headers are not case-normalized)", () => {
  const allowed = parseAllowedHosts("Ops.Example.COM");
  assert.equal(isAllowedHost("ops.example.com:8403", allowed, "private"), true);
  assert.equal(isAllowedHost("LOCALHOST", [], "private"), true);
});

test("a missing Host is refused in private mode", () => {
  assert.equal(isAllowedHost(undefined, [], "private"), false);
  assert.equal(isAllowedHost("", [], "private"), false);
});

test("authed mode does not host-check — Basic auth already defeats rebinding", () => {
  // The browser holds no credential for the attacker's origin, so the rebound
  // request 401s. Host-checking here would break every reverse-proxy deployment.
  assert.equal(isAllowedHost("anything.example.com", [], "authed"), true);
});

test("public mode does not host-check — nothing sensitive is served", () => {
  assert.equal(isAllowedHost("anything.example.com", [], "public"), true);
});

test("parseAllowedHosts trims, lowercases, and drops blanks", () => {
  assert.deepEqual(parseAllowedHosts("  A.test , ,b.test  "), ["a.test", "b.test"]);
  assert.deepEqual(parseAllowedHosts(""), []);
  assert.deepEqual(parseAllowedHosts("   "), []);
});
