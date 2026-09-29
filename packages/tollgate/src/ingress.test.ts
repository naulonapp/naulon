/**
 * The ingress primitives: which `Forwarded` element is trusted, what counts as a site host, the
 * constant-time secret check, and the shared-cache guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientAddressOf,
  edgeSecretDigest,
  edgeSecretMatches,
  isIngressHost,
  lastForwardedElement,
  privateToIngress,
  siteHostOf,
} from "./ingress.ts";

test("Forwarded: the LAST element is the one trusted, never an earlier one a client sent", () => {
  const el = lastForwardedElement("host=victim.example;for=1.1.1.1, for=203.0.113.9;host=www.site.example;proto=https");
  assert.deepEqual(el, { for: "203.0.113.9", host: "www.site.example", proto: "https" });
});

test("Forwarded: quoted values, a comma inside quotes, and case-insensitive names", () => {
  const el = lastForwardedElement('For="[2001:db8::1]:4711";HOST="www.site.example"');
  assert.equal(el?.host, "www.site.example");
  assert.equal(el?.for, "[2001:db8::1]:4711");
  assert.equal(lastForwardedElement('for="a,b";host=www.x.example')?.host, "www.x.example");
});

test("Forwarded: absent, empty or trailing-comma headers name nothing", () => {
  assert.equal(lastForwardedElement(null), undefined);
  assert.equal(lastForwardedElement(""), undefined);
  assert.equal(lastForwardedElement("host=www.a.example,"), undefined);
});

test("site host: lowercased, port and trailing dot dropped; IPs and single labels refused", () => {
  assert.equal(siteHostOf("WWW.Site.Example:443"), "www.site.example");
  assert.equal(siteHostOf("www.site.example."), "www.site.example");
  assert.equal(siteHostOf("203.0.113.9"), undefined);
  assert.equal(siteHostOf("localhost"), undefined);
  assert.equal(siteHostOf("www.site.example/path"), undefined);
  assert.equal(siteHostOf(undefined), undefined);
});

test("client address: IPv4 and bracketed IPv6 with ports; obfuscated and unknown refused", () => {
  assert.equal(clientAddressOf("203.0.113.9:8080"), "203.0.113.9");
  assert.equal(clientAddressOf("[2001:DB8::1]:4711"), "2001:db8::1");
  assert.equal(clientAddressOf("_hidden"), undefined);
  assert.equal(clientAddressOf("unknown"), undefined);
  assert.equal(clientAddressOf("not-an-ip"), undefined);
  assert.equal(clientAddressOf("999.1.1.1"), undefined);
  // A Cloudflare Worker's cf-connecting-ip, verbatim from the S0 walk: bare, unbracketed IPv6.
  assert.equal(clientAddressOf("240b:11:1a62:2300:bd11:bca7:bb83:20f1"), "240b:11:1a62:2300:bd11:bca7:bb83:20f1");
});

test("edge secret: matches either of two live digests, and nothing else", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const digests = [edgeSecretDigest(a), edgeSecretDigest(b)];
  assert.equal(edgeSecretMatches(a, digests), true);
  assert.equal(edgeSecretMatches(b, digests), true);
  assert.equal(edgeSecretMatches("a".repeat(39), digests), false);
  assert.equal(edgeSecretMatches("", digests), false);
  assert.equal(edgeSecretMatches(null, digests), false);
  assert.equal(edgeSecretMatches(a, []), false);
  assert.equal(edgeSecretMatches(a, ["not-hex"]), false);
});

test("ingress host: case and port ignored; no ingress configured matches nothing", () => {
  const ingress = { host: "ingress.naulon.test", resolve: async () => undefined };
  assert.equal(isIngressHost("INGRESS.naulon.test:443", ingress), true);
  assert.equal(isIngressHost("ingress.naulon.test.", ingress), true, "a fully qualified Host with its root dot");
  assert.equal(isIngressHost("www.site.example", ingress), false);
  assert.equal(isIngressHost("ingress.naulon.test", undefined), false);
});

test("shared-cache guard: public becomes private, no-store is left alone, other directives kept", () => {
  const cc = (v: string | null) => {
    const res = new Response("x", v === null ? {} : { headers: { "cache-control": v } });
    return privateToIngress(res).headers.get("cache-control");
  };
  assert.equal(cc("public, max-age=600, s-maxage=3600"), "private, max-age=600");
  assert.equal(cc("no-store"), "no-store");
  assert.equal(cc("private, no-cache"), "private, no-cache");
  assert.equal(cc(null), "private");
});
