/**
 * The proof link — the URL a citation carries so a reader can open the record.
 *
 * A record is minted, signed and permanently hosted, and until this existed no tool output
 * carried anything a reader could click. These helpers are the one place the URL's shape is
 * decided; every emitter (wayfarer's citation block, the four MCP tools, the x402 manifest)
 * calls them rather than spelling the query string itself.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { issuerHost, proofPageUrl, recordUrl } from "./proof.ts";

test("issuerHost strips the naulon: prefix and nothing else", () => {
  assert.equal(issuerHost("naulon:inneraxiom.com"), "inneraxiom.com");
  assert.equal(issuerHost("naulon:localhost:11100"), "localhost:11100", "a port is part of the host");
  assert.equal(issuerHost("NAULON:Gate.Naulon.App"), "gate.naulon.app", "lower-cased, like licenseIdentityFor");
});

test("issuerHost refuses anything that is not a naulon identity", () => {
  assert.equal(issuerHost(undefined), undefined);
  assert.equal(issuerHost(""), undefined);
  assert.equal(issuerHost("https://inneraxiom.com"), undefined, "a URL is not an identity");
  assert.equal(issuerHost("naulon:"), undefined, "an empty host is no host");
  assert.equal(issuerHost("naulon:evil.com/path?x"), undefined, "a host carries no path or query");
});

test("proofPageUrl names the publisher and the settlement, encoded, on the verify page", () => {
  const url = proofPageUrl({ verifyUrl: "https://naulon.app/verify", host: "inneraxiom.com", jti: "07e4a7de-1111-2222-3333-444444444444" });
  assert.equal(url, "https://naulon.app/verify?host=inneraxiom.com&jti=07e4a7de-1111-2222-3333-444444444444");
});

test("proofPageUrl survives a verify page that already carries a query, and a jti that needs encoding", () => {
  const url = proofPageUrl({ verifyUrl: "https://self.host/verify?lang=de", host: "localhost:11100", jti: "a b&c" });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://self.host/verify");
  assert.equal(u.searchParams.get("lang"), "de");
  assert.equal(u.searchParams.get("host"), "localhost:11100");
  assert.equal(u.searchParams.get("jti"), "a b&c");
});

test("recordUrl is the gate's own record route, with no hint when the gate IS the publisher", () => {
  assert.equal(
    recordUrl({ gateOrigin: "https://blog.example.com", host: "blog.example.com", jti: "j-1" }),
    "https://blog.example.com/licenses/j-1/record",
  );
  assert.equal(
    recordUrl({ gateOrigin: "https://Blog.Example.com/", host: "blog.example.com", jti: "j-1" }),
    "https://blog.example.com/licenses/j-1/record",
    "origin comparison is case-insensitive and a trailing slash is not a different gate",
  );
});

test("recordUrl carries the publisher hint when the gate fronts many publishers", () => {
  // The self-served publisher: their own origin has no record route, the fleet gate does, and a
  // browser cannot set Host — so the hint is the only way to name them.
  assert.equal(
    recordUrl({ gateOrigin: "https://gate.naulon.app", host: "inneraxiom.com", jti: "j-2" }),
    "https://gate.naulon.app/licenses/j-2/record?host=inneraxiom.com",
  );
  const encoded = recordUrl({ gateOrigin: "https://gate.naulon.app", host: "localhost:11100", jti: "a/b" });
  assert.equal(encoded, "https://gate.naulon.app/licenses/a%2Fb/record?host=localhost%3A11100");
});

test("recordUrl refuses a gate origin that is not an origin", () => {
  assert.throws(() => recordUrl({ gateOrigin: "not a url", host: "x.com", jti: "j" }), /gateOrigin/);
});
