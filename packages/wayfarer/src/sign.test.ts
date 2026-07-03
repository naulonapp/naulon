/**
 * The wayfarer's Web Bot Auth identity: configured, every outbound request
 * carries the three signed headers; unconfigured, agentFetch is a plain fetch
 * with byte-identical headers (the same regression bar the gate's verifier
 * holds for unsigned traffic).
 */
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { botAuthKeyFromSeed, resetConfig } from "@naulon/shared";
import { agentFetch, botAuthHeadersFor, resetAgentIdentity } from "./sign.ts";

const SEED = Buffer.alloc(32, 11).toString("base64url");

function configure(on: boolean): void {
  if (on) {
    process.env.BOT_AUTH_SIGNING_KEY = SEED;
    process.env.BOT_AUTH_SIGNATURE_AGENT = "naulon.app";
  } else {
    delete process.env.BOT_AUTH_SIGNING_KEY;
    delete process.env.BOT_AUTH_SIGNATURE_AGENT;
  }
  resetConfig();
  resetAgentIdentity();
}

afterEach(() => configure(false));

test("configured: botAuthHeadersFor signs @authority for the target host", () => {
  configure(true);
  const h = botAuthHeadersFor("http://127.0.0.1:11100/essays/on-stillness");
  assert.ok(h);
  const key = botAuthKeyFromSeed(SEED);
  assert.match(h["signature-input"]!, new RegExp(`keyid="${key.keyid}";tag="web-bot-auth"$`));
  assert.equal(h["signature-agent"], '"naulon.app"');
  // Signature verifies over @authority = the URL's host:port.
  const member = h["signature-input"]!.slice("sig1=".length);
  const base = `"@authority": 127.0.0.1:11100\n"@signature-params": ${member}`;
  const sig = Buffer.from(h["signature"]!.slice("sig1=:".length, -1), "base64");
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
  assert.ok(cryptoVerify(null, Buffer.from(base, "utf8"), pub, sig));
});

test("configured: agentFetch merges the signed headers under the caller's", async () => {
  configure(true);
  let seen: Record<string, string> | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = init?.headers as Record<string, string>;
    return new Response("ok");
  }) as typeof fetch;
  try {
    await agentFetch("http://gate.example/essays/x", { headers: { "user-agent": "naulon-wayfarer/0.1" } });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen);
  assert.equal(seen["user-agent"], "naulon-wayfarer/0.1");
  assert.ok(seen["signature-input"]);
  assert.ok(seen["signature"]);
  assert.equal(seen["signature-agent"], '"naulon.app"');
});

test("unconfigured: no signing — the init reaches fetch untouched (regression bar)", async () => {
  configure(false);
  assert.equal(botAuthHeadersFor("http://gate.example/essays/x"), null);
  const init = { headers: { "user-agent": "naulon-wayfarer/0.1" } };
  let seenInit: RequestInit | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
    seenInit = i;
    return new Response("ok");
  }) as typeof fetch;
  try {
    await agentFetch("http://gate.example/essays/x", init);
  } finally {
    globalThis.fetch = real;
  }
  // The exact same object — not a copy, not augmented.
  assert.equal(seenInit, init);
});
