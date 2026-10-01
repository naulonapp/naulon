import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkClientIp } from "./clientIp.ts";

const req = (h: Record<string, string>) => new Request("https://site.test/a", { headers: h });

test("auto-detects Vercel and Netlify from env", () => {
  assert.equal(sdkClientIp(req({ "x-vercel-forwarded-for": "66.249.64.9" }), undefined, { VERCEL: "1" }), "66.249.64.9");
  assert.equal(sdkClientIp(req({ "x-real-ip": "66.249.64.9" }), undefined, { VERCEL: "1" }), "66.249.64.9");
  assert.equal(sdkClientIp(req({ "x-nf-client-connection-ip": "66.249.64.9" }), undefined, { NETLIFY: "true" }), "66.249.64.9");
});

test("cloudflare preset prefers IPv6 over pseudo-IPv4", () => {
  assert.equal(sdkClientIp(req({ "cf-connecting-ip": "240.16.0.1", "cf-connecting-ipv6": "2001:4860:4801:10::9" }), "cloudflare", {}), "2001:4860:4801:10::9");
  assert.equal(sdkClientIp(req({ "cf-connecting-ip": "66.249.64.9" }), "cloudflare", {}), "66.249.64.9");
});

test("nothing detected and nothing configured: no IP, never a guess from X-Forwarded-For", () => {
  assert.equal(sdkClientIp(req({ "x-forwarded-for": "9.9.9.9" }), undefined, {}), null);
});

test("an explicit header and none", () => {
  assert.equal(sdkClientIp(req({ "x-client": "9.9.9.9, 10.0.0.1" }), { header: "X-Client" }, {}), "9.9.9.9");
  assert.equal(sdkClientIp(req({ "x-vercel-forwarded-for": "9.9.9.9" }), "none", { VERCEL: "1" }), null);
});

test("Vercel behind Cloudflare without the preset returns Cloudflare's address, which the check then refuses", () => {
  assert.equal(sdkClientIp(req({ "x-vercel-forwarded-for": "173.245.48.9" }), undefined, { VERCEL: "1" }), "173.245.48.9");
});
