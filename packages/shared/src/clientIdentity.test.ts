import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedFor, resolveClientIdentity } from "./clientIdentity.ts";

test("peer address is the identity when there is no trusted proxy", () => {
  const r = resolveClientIdentity({ xff: undefined, peer: "203.0.113.9", trustProxy: false });
  assert.deepEqual(r, { ok: true, key: "203.0.113.9", source: "peer" });
});

test("X-Forwarded-For is ignored unless TRUST_PROXY", () => {
  const r = resolveClientIdentity({ xff: "1.2.3.4", peer: "203.0.113.9", trustProxy: false });
  assert.equal(r.ok && r.key, "203.0.113.9");
});

// ── The end of the trail matters ─────────────────────────────────────────────────
// XFF is appended left-to-right, so the leftmost entry is whatever the ORIGINAL caller
// claimed. Keying on it hands every client a private bucket for the price of one
// header, which is the same as having no limiter.

test("a client-forged XFF entry cannot buy its own bucket", () => {
  // Client sent "evil"; our proxy appended what it actually saw.
  const a = resolveClientIdentity({
    xff: "evil, 203.0.113.9",
    peer: "10.0.0.1",
    trustProxy: true,
  });
  const b = resolveClientIdentity({
    xff: "other-lie, 203.0.113.9",
    peer: "10.0.0.1",
    trustProxy: true,
  });
  assert.equal(a.ok && a.key, "203.0.113.9");
  assert.equal(b.ok && b.key, "203.0.113.9");
  // Two different forged values must land in the SAME bucket.
  assert.equal(a.ok && b.ok && a.key === b.key, true);
});

test("one trusted hop → the address that hop observed", () => {
  const r = resolveClientIdentity({ xff: "203.0.113.9", peer: "127.0.0.1", trustProxy: true });
  assert.deepEqual(r, { ok: true, key: "203.0.113.9", source: "forwarded" });
});

test("two trusted hops → step past the CDN to the real client", () => {
  // client → CDN → our proxy → gate. Without hops=2 every request behind one CDN
  // edge shares a bucket.
  const r = resolveClientIdentity({
    xff: "203.0.113.9, 198.51.100.7",
    peer: "127.0.0.1",
    trustProxy: true,
    hops: 2,
  });
  assert.equal(r.ok && r.key, "203.0.113.9");
});

test("a trail shorter than the configured hop count falls back to the leftmost entry", () => {
  const r = resolveClientIdentity({ xff: "203.0.113.9", peer: undefined, trustProxy: true, hops: 3 });
  assert.equal(r.ok && r.key, "203.0.113.9");
});

test("hops below 1 is clamped, never an index off the end", () => {
  const r = resolveClientIdentity({
    xff: "a, b",
    peer: undefined,
    trustProxy: true,
    hops: 0,
  });
  assert.equal(r.ok && r.key, "b");
});

// ── No socket peer is itself evidence of a proxy ─────────────────────────────────
// A caller cannot reach us over a socket we cannot see, so an absent peer means
// something adapter-shaped is in front. The header is then the only signal there is,
// and using it beats the alternative: TRUST_PROXY defaults to false, so requiring it
// removed metering entirely from serverless deployments — the ones on the open
// internet.

test("no peer at all → the forwarded header is used even without TRUST_PROXY", () => {
  const r = resolveClientIdentity({ xff: "1.2.3.4", peer: undefined, trustProxy: false });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.key, "1.2.3.4");
  assert.equal(r.ok && r.source, "forwarded");
});

test("the inference reads from the right, exactly like the trusted path", () => {
  const r = resolveClientIdentity({ xff: "forged, 198.51.100.7", peer: undefined, trustProxy: false });
  assert.equal(r.ok && r.key, "198.51.100.7", "a caller's own claim sits on the left");
});

test("a caller WITH a socket peer can never be identified by its own header", () => {
  // The forgeable case, and the reason the inference is scoped to a missing peer: a
  // direct client always has one, so its X-Forwarded-For stays ignored.
  const r = resolveClientIdentity({ xff: "1.2.3.4", peer: "203.0.113.99", trustProxy: false });
  assert.equal(r.ok && r.key, "203.0.113.99");
  assert.equal(r.ok && r.source, "peer");
});

// ── Unidentifiable is reported, never bucketed under a placeholder ───────────────

test("no peer and no XFF at all → not ok", () => {
  const r = resolveClientIdentity({ xff: undefined, peer: undefined, trustProxy: true });
  assert.equal(r.ok, false);
});

test("an empty or comma-only XFF is not an identity", () => {
  for (const xff of ["", "   ", ",", " , "]) {
    const r = resolveClientIdentity({ xff, peer: undefined, trustProxy: true });
    assert.equal(r.ok, false, `expected no identity for ${JSON.stringify(xff)}`);
  }
});

test("forwardedFor trims whitespace around entries", () => {
  assert.equal(forwardedFor("  a  ,  b  ", 1), "b");
});
