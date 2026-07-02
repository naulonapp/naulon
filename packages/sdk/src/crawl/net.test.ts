import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedTarget } from "./net.ts";

test("isBlockedTarget blocks loopback v4", () => {
  assert.equal(isBlockedTarget("127.0.0.1"), true);
  assert.equal(isBlockedTarget("127.5.6.7"), true);
});

test("isBlockedTarget blocks the RFC1918 private ranges", () => {
  assert.equal(isBlockedTarget("10.0.0.1"), true);
  assert.equal(isBlockedTarget("172.16.0.1"), true);
  assert.equal(isBlockedTarget("172.31.255.255"), true);
  assert.equal(isBlockedTarget("192.168.1.1"), true);
});

test("isBlockedTarget blocks 172.x OUTSIDE the /12 as public", () => {
  // 172.15 and 172.32 are public — the mask must be /12, not a naive /16.
  assert.equal(isBlockedTarget("172.15.0.1"), false);
  assert.equal(isBlockedTarget("172.32.0.1"), false);
});

test("isBlockedTarget blocks link-local incl. the cloud metadata IP", () => {
  assert.equal(isBlockedTarget("169.254.0.1"), true);
  assert.equal(isBlockedTarget("169.254.169.254"), true); // AWS/GCP metadata
});

test("isBlockedTarget blocks the 'this' network and CGNAT", () => {
  assert.equal(isBlockedTarget("0.0.0.0"), true);
  assert.equal(isBlockedTarget("100.64.0.1"), true);
  assert.equal(isBlockedTarget("100.127.255.255"), true);
  assert.equal(isBlockedTarget("100.63.255.255"), false); // just below CGNAT
});

test("isBlockedTarget passes ordinary public v4", () => {
  assert.equal(isBlockedTarget("8.8.8.8"), false);
  assert.equal(isBlockedTarget("1.1.1.1"), false);
});

test("isBlockedTarget blocks v6 loopback / unspecified / link-local / ULA", () => {
  assert.equal(isBlockedTarget("::1"), true);
  assert.equal(isBlockedTarget("::"), true);
  assert.equal(isBlockedTarget("fe80::1"), true);
  assert.equal(isBlockedTarget("fc00::1"), true);
  assert.equal(isBlockedTarget("fd12:3456::1"), true);
});

test("isBlockedTarget unwraps IPv4-mapped v6 and checks as v4", () => {
  assert.equal(isBlockedTarget("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedTarget("::ffff:8.8.8.8"), false);
});

test("isBlockedTarget returns false for a hostname (resolved elsewhere)", () => {
  // A DNS name is not a literal IP — the connect-time guarded lookup checks it.
  assert.equal(isBlockedTarget("example.com"), false);
  assert.equal(isBlockedTarget("localhost"), false);
});
