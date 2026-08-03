import test from "node:test";
import assert from "node:assert/strict";

import { externalScheme, externalUrl } from "./externalScheme.ts";

test("without TRUST_PROXY the forwarded scheme is ignored", () => {
  assert.equal(
    externalScheme({ xfp: "https", observed: "http", trustProxy: false }),
    "http",
    "a self-hosted gate directly exposed must not let a caller dictate its own public scheme",
  );
});

test("with TRUST_PROXY the forwarded scheme wins — the TLS-terminating edge is the authority", () => {
  assert.equal(externalScheme({ xfp: "https", observed: "http", trustProxy: true }), "https");
});

test("a client-forged entry is ignored: the trail is read from the RIGHT", () => {
  // Same trail semantics as X-Forwarded-For. A caller who prepends a forged value
  // sits at the LEFT; the entry our own trusted hop appended is at the right.
  assert.equal(
    externalScheme({ xfp: "https, http", observed: "http", trustProxy: true, hops: 1 }),
    "http",
    "the forged leftmost entry must not become the advertised scheme",
  );
});

test("two trusted hops read one further out (a CDN in front of the proxy)", () => {
  assert.equal(
    externalScheme({ xfp: "https, http", observed: "http", trustProxy: true, hops: 2 }),
    "https",
  );
});

test("a junk forwarded scheme falls back to what the server observed", () => {
  // The value lands inside a URL that goes into a SIGNED payment quote — anything
  // that is not a scheme we serve is refused rather than propagated.
  for (const junk of ["javascript", "gopher", "", "  ", "https://evil.example", "HTTPS\r\nX: y"]) {
    assert.equal(
      externalScheme({ xfp: junk, observed: "http", trustProxy: true }),
      "http",
      `junk scheme ${JSON.stringify(junk)} must not be propagated`,
    );
  }
});

test("scheme comparison is case-insensitive and whitespace-tolerant", () => {
  assert.equal(externalScheme({ xfp: " HTTPS ", observed: "http", trustProxy: true }), "https");
});

test("no forwarded header at all → what the server observed", () => {
  assert.equal(externalScheme({ xfp: undefined, observed: "https", trustProxy: true }), "https");
});

test("externalUrl rewrites only the scheme, preserving host, path and query", () => {
  const req = new Request("http://fleet.raxtzu.com/articles/what-a-toll-proves?x=1#frag", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(
    externalUrl(req, { trustProxy: true }),
    "https://fleet.raxtzu.com/articles/what-a-toll-proves?x=1",
    "the resource identifier in a signed quote must match the URL the buyer actually fetched",
  );
});

test("externalUrl is a no-op when the gate already terminates TLS itself", () => {
  const req = new Request("https://fleet.raxtzu.com/articles/x");
  assert.equal(externalUrl(req, { trustProxy: true }), "https://fleet.raxtzu.com/articles/x");
});

test("externalUrl without trustProxy leaves the observed URL alone", () => {
  const req = new Request("http://localhost:8402/articles/x", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(externalUrl(req, { trustProxy: false }), "http://localhost:8402/articles/x");
});
