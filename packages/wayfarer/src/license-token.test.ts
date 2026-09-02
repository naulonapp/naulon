import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearLicenseTokens, licenseTokenFor, rememberLicenseToken } from "./license-token.ts";
import { agentFetch } from "./sign.ts";

beforeEach(() => clearLicenseTokens());

test("a token covers every url its resource pattern admits, on that origin only", () => {
  rememberLicenseToken({ origin: "https://pub.example", resource: "/papers/*", token: "t1", expiresAt: null });
  assert.equal(licenseTokenFor("https://pub.example/papers/2026/q.pdf"), "t1");
  assert.equal(licenseTokenFor("https://pub.example/blog/x"), null, "outside the pattern");
  assert.equal(licenseTokenFor("https://other.example/papers/x"), null, "a token is not a bearer for the whole web");
});

test("the most specific pattern wins, matching how the terms themselves resolved", () => {
  rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "broad", expiresAt: null });
  rememberLicenseToken({ origin: "https://pub.example", resource: "/papers/*", token: "narrow", expiresAt: null });
  assert.equal(licenseTokenFor("https://pub.example/papers/q.pdf"), "narrow");
  assert.equal(licenseTokenFor("https://pub.example/about"), "broad");
});

test("an expired token is not presented", () => {
  rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "old", expiresAt: 1_000 });
  assert.equal(licenseTokenFor("https://pub.example/x", 999), "old");
  assert.equal(licenseTokenFor("https://pub.example/x", 1_000), null, "at the deadline it is already gone");
  assert.equal(licenseTokenFor("https://pub.example/x", 2_000), null);
});

test("re-acquiring replaces the old token rather than racing it", () => {
  rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "first", expiresAt: null });
  rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "second", expiresAt: null });
  assert.equal(licenseTokenFor("https://pub.example/x"), "second");
});

test("a malformed url asks for no token instead of throwing", () => {
  rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "t", expiresAt: null });
  assert.equal(licenseTokenFor("not a url"), null);
});

test("agentFetch presents the token as CAP requires, and never over a caller's own Authorization", async () => {
  // The header is attached in ONE place because four call sites in buyer.ts build headers of their
  // own; a token remembered at each is a token forgotten at one.
  const seen: Array<Record<string, string>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined) ?? {});
    return new Response("ok");
  }) as typeof fetch;
  try {
    rememberLicenseToken({ origin: "https://pub.example", resource: "/", token: "tok-9", expiresAt: null });
    await agentFetch("https://pub.example/a", { headers: { "user-agent": "x" } });
    assert.equal(seen[0]!["authorization"], "License tok-9");
    assert.equal(seen[0]!["user-agent"], "x", "the caller's own headers survive");

    await agentFetch("https://pub.example/a", { headers: { authorization: "Bearer mine" } });
    assert.equal(seen[1]!["authorization"], "Bearer mine", "a caller that set its own auth knows something we do not");

    await agentFetch("https://elsewhere.example/a", { headers: {} });
    assert.equal(seen[2]!["authorization"], undefined, "no token for that origin");
  } finally {
    globalThis.fetch = real;
    clearLicenseTokens();
  }
});
