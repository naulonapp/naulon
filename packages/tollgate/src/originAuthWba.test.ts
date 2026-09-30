/**
 * Web Bot Auth on the origin pull: when the operator configures a signing identity
 * (BOT_AUTH_SIGNING_KEY) AND the directory host to advertise (BOT_AUTH_SIGNATURE_AGENT),
 * the gate ALSO signs its origin proxy fetch with the three RFC 9421 headers — so a
 * Cloudflare/Vercel-verified publisher recognizes fleet traffic without a pasted bypass
 * rule. The identity is the SAME operator key the gate's directory publishes (not a new
 * crawler). The per-tenant secret header keeps being sent alongside (migration-safe).
 *
 * The "unset ⇒ byte-identical" bar lives in originAuth.test.ts (a gate booted with no
 * identity). This file boots one WITH the identity — env is set BEFORE importing app.ts
 * because the gate reads its config once at module load.
 */
import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";

const SEED = Buffer.alloc(32, 7).toString("base64url");
process.env.EVENTS_PATH = join(tmpdir(), `naulon-wba-${process.pid}.jsonl`);
process.env.BOT_AUTH_SIGNING_KEY = SEED;
process.env.BOT_AUTH_SIGNATURE_AGENT = "https://naulon.app";
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { usdc, walletAddress, botAuthKeyFromSeed } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

function pub(originUrl: string, originAuthSecret?: string): PublisherConfig {
  return {
    id: "p",
    originUrl,
    articlePrefixes: ["essays"],
    price: usdc(0.001),
    citationMultiplier: 5,
    credits: {
      async resolve(slug: string) {
        return { slug, title: slug, contributors: [{ authorId: "a", wallet: walletAddress("0x0000000000000000000000000000000000000001") }] };
      },
    },
    licenseIdentity: "naulon:p",
    originAuthSecret,
  };
}

let current: PublisherConfig = pub("https://origin.example");
const app = createApp({ async resolve() { return current; } });

const realFetch = globalThis.fetch;
let captured: Headers[] = [];
before(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    captured.push(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]));
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
beforeEach(() => { captured = []; });
after(() => { globalThis.fetch = realFetch; });

test("https origin + identity configured → the pull carries the three RFC 9421 headers", async () => {
  current = pub("https://origin.example");
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.get("signature"), "Signature header present");
  const input = captured[0]!.get("signature-input");
  assert.ok(input, "Signature-Input header present");
  // Web-bot-auth request profile, keyed by the operator's directory thumbprint.
  assert.match(input, /tag="web-bot-auth"/);
  assert.match(input, new RegExp(`keyid="${botAuthKeyFromSeed(SEED).keyid}"`));
  // CF profile: Signature-Agent MUST be a plain double-quoted string.
  assert.equal(captured[0]!.get("signature-agent"), '"https://naulon.app"');
});

test("http origin → NOT signed (cleartext guard, mirrors the secret header)", async () => {
  current = pub("http://origin.local");
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured[0]!.get("signature"), null);
  assert.equal(captured[0]!.get("signature-agent"), null);
});

test("secret header and WBA signature coexist on the same pull (migration-safe)", async () => {
  current = pub("https://origin.example", "nlo_secret");
  await app.request("/about", { headers: { host: "p.example" } });
  assert.equal(captured[0]!.get("x-naulon-origin-auth"), "nlo_secret");
  assert.ok(captured[0]!.get("signature"), "signature still present alongside the secret");
});

test("the pull is signed over the origin host AND the path, and verifies only for that path", async () => {
  current = pub("https://origin.example");
  await app.request("/about?x=1", { headers: { host: "p.example" } });
  const input = captured[0]!.get("signature-input") ?? "";
  assert.match(input, /\("@authority" "@path" "x-naulon-publisher"\)/);
  const publisher = captured[0]!.get("x-naulon-publisher") ?? "";
  assert.ok(publisher.length > 0, "the pull names the publisher it was decided for");
  // Rebuild the RFC 9421 base the way a publisher runtime would, and check it against the
  // operator's public key: this page verifies, any other page of the same host does not.
  const member = input.replace(/^sig1=/, "");
  const sig = Buffer.from((captured[0]!.get("signature") ?? "").replace(/^sig1=:|:$/g, ""), "base64");
  const pub1 = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: botAuthKeyFromSeed(SEED).x }, format: "jwk" });
  const base = (path: string, pub = publisher) =>
    Buffer.from(`"@authority": origin.example\n"@path": ${path}\n"x-naulon-publisher": ${pub}\n"@signature-params": ${member}`, "utf8");
  assert.equal(verify(null, base("/about"), pub1, sig), true);
  assert.equal(verify(null, base("/other"), pub1, sig), false);
  assert.equal(verify(null, base("/about", "someone-else"), pub1, sig), false);
});

test("a client cannot smuggle its own x-naulon-publisher to the origin", async () => {
  current = pub("https://origin.example");
  await app.request("/about", { headers: { host: "p.example", "x-naulon-publisher": "forged" } });
  assert.notEqual(captured[0]!.get("x-naulon-publisher"), "forged");
});
