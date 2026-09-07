import { test } from "node:test";
import assert from "node:assert/strict";
import { bazaarExtension, isValidRouteTemplate, routeTemplateFor, serviceMetadata } from "./bazaar.ts";

test("the declaration matches the spec's HTTP GET discovery shape", () => {
  const ext = bazaarExtension("text/html");
  assert.equal(ext.info.input.type, "http");
  assert.equal(ext.info.input.method, "GET");
  assert.equal(ext.info.output.type, "text");
  assert.equal(ext.info.output.format, "text/html");
  assert.ok(ext.schema.$schema, "the v2 pattern carries the schema beside the data");
});

test("a JSON origin is declared as json, not guessed as text", () => {
  assert.equal(bazaarExtension("application/json").info.output.type, "json");
  assert.equal(bazaarExtension("application/json").info.output.format, "application/json");
});

test("serviceName is the HOST — the authority that hosts the resource", () => {
  assert.equal(serviceMetadata("https://blog.example.com/essays/x", "read").serviceName, "blog.example.com");
  assert.equal(serviceMetadata("https://a.test:8443/x", "read").serviceName, "a.test:8443");
});

test("a host that would be dropped by the facilitator is not sent at all", () => {
  // Spec: serviceName must be printable ASCII, <= 32 chars, or the field is discarded.
  // Truncating a hostname would invent a DIFFERENT host, so the field is omitted instead.
  const long = `https://${"a".repeat(40)}.example.com/x`;
  assert.equal(serviceMetadata(long, "read").serviceName, undefined);
  assert.equal(serviceMetadata("not a url", "read").serviceName, undefined);
});

test("tags carry the toll kind, deduplicated, inside the spec's cap", () => {
  assert.deepEqual(serviceMetadata("https://h.test/x", "read").tags, ["citation", "x402", "read"]);
  // A citation toll must not send "citation" twice — the facilitator dedupes anyway,
  // so the duplicate is pure waste on the wire.
  assert.deepEqual(serviceMetadata("https://h.test/x", "citation").tags, ["citation", "x402"]);
  assert.ok((serviceMetadata("https://h.test/x", "read").tags ?? []).length <= 5);
});

test("no iconUrl is ever offered", () => {
  // The fleet is multi-tenant; the only icon it could send is the operator's, which
  // would brand every publisher's catalog entry with someone else's mark.
  assert.equal("iconUrl" in serviceMetadata("https://h.test/x", "read"), false);
});

test("a prefixed toll catalogs as ONE route, not one row per article", () => {
  assert.equal(routeTemplateFor("/essays/on-stillness", ["essays"]), "/essays/:slug");
  assert.equal(routeTemplateFor("/essays/on-stillness", ["blog", "essays"]), "/essays/:slug");
  assert.equal(routeTemplateFor("/essays/on-stillness", ["/essays/"]), "/essays/:slug");
});

test("a shape the configured scope does not actually cover gets NO template", () => {
  // Over-claiming in someone else's catalog is worse than a few extra rows in it.
  assert.equal(routeTemplateFor("/essays/2026/on-stillness", ["essays"]), undefined, "deeper than one segment");
  assert.equal(routeTemplateFor("/essays/", ["essays"]), undefined, "no slug at all");
  assert.equal(routeTemplateFor("/about", ["essays"]), undefined, "not under the prefix");
  assert.equal(routeTemplateFor("/essays/x", []), undefined, "no prefixes configured (site mode)");
});

test("the spec's template rules are applied before we send, not after they drop it", () => {
  assert.equal(isValidRouteTemplate("/essays/:slug"), true);
  assert.equal(isValidRouteTemplate("/weather/:country/:city"), true);
  assert.equal(isValidRouteTemplate("essays/:slug"), false, "must start with /");
  assert.equal(isValidRouteTemplate(""), false);
  assert.equal(isValidRouteTemplate("/essays/../admin"), false, "traversal");
  assert.equal(isValidRouteTemplate("/essays/%2e%2e/admin"), false, "traversal, percent-encoded");
  assert.equal(isValidRouteTemplate("/http://evil.com"), false, "scheme injection");
  assert.equal(isValidRouteTemplate("/essays/%zz"), false, "malformed percent-encoding");
  assert.equal(isValidRouteTemplate("/essays/:slug?x=1"), false, "not a path character");
});

test("the extension omits routeTemplate entirely when there is none", () => {
  assert.equal("routeTemplate" in bazaarExtension("text/html"), false);
  assert.equal(bazaarExtension("text/html", "/essays/:slug").routeTemplate, "/essays/:slug");
});
