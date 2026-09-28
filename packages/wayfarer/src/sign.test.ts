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
import { clearLicenseTokens, licenseTokenFor, rememberLicenseToken } from "./license-token.ts";

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

async function headersSentBy(url: string): Promise<Record<string, string>> {
  let seen: Record<string, string> = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers as Record<string, string>) ?? {};
    return new Response("ok");
  }) as typeof fetch;
  try {
    await agentFetch(url);
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

test("presenting a licence token: the signature also covers @path, so it cannot be replayed on another URL", async () => {
  configure(true);
  clearLicenseTokens();
  rememberLicenseToken({ origin: "http://gate.example", resource: "/essays/*", token: "tok-9", expiresAt: null });
  try {
    const seen = await headersSentBy("http://gate.example/essays/x?page=2");
    assert.equal(seen["authorization"], "License tok-9");
    assert.match(seen["signature-input"]!, /^sig1=\("@authority" "@path"\);/);
    const key = botAuthKeyFromSeed(SEED);
    const member = seen["signature-input"]!.slice("sig1=".length);
    // `@path` is the path alone (RFC 9421 §2.2.6): the gate's verifier rebuilds it from the pathname,
    // so a query in the signed value would fail every read of a URL that carries one.
    const base = `"@authority": gate.example\n"@path": /essays/x\n"@signature-params": ${member}`;
    const sig = Buffer.from(seen["signature"]!.slice("sig1=:".length, -1), "base64");
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    assert.equal(cryptoVerify(null, Buffer.from(base), pub, sig), true);
  } finally {
    clearLicenseTokens();
  }
});

test("no licence token: the signature stays authority-only", async () => {
  configure(true);
  clearLicenseTokens();
  const seen = await headersSentBy("http://gate.example/essays/x");
  assert.match(seen["signature-input"]!, /^sig1=\("@authority"\);/);
});

test("botAuthHeadersFor can cover the path when asked", () => {
  configure(true);
  const h = botAuthHeadersFor("https://gate.example/_naulon/olp/token", { coverPath: true });
  assert.match(h!["signature-input"]!, /^sig1=\("@authority" "@path"\);/);
});

/** Stub fetch with a scripted sequence of responses; records each request's url and headers. */
async function withScript(responses: Response[], run: () => Promise<Response>): Promise<{ sent: Array<{ url: string; headers: Record<string, string>; redirect?: string }>; out: Response }> {
  const sent: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {}, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    return responses.shift() ?? new Response("ok");
  }) as typeof fetch;
  try {
    return { sent, out: await run() };
  } finally {
    globalThis.fetch = real;
  }
}

test("a licensed read that redirects on its own origin is signed again for the new path", async () => {
  configure(true);
  clearLicenseTokens();
  rememberLicenseToken({ origin: "https://pub.example", resource: "/essays/*", token: "tok-r", expiresAt: null });
  try {
    const { sent, out } = await withScript(
      [new Response(null, { status: 301, headers: { location: "/essays/x/" } }), new Response("page")],
      () => agentFetch("https://pub.example/essays/x"),
    );
    assert.equal(await out.text(), "page");
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.redirect, "manual", "fetch must not carry the first signature onto the next path");
    assert.equal(sent[1]!.url, "https://pub.example/essays/x/");
    assert.equal(sent[1]!.headers["authorization"], "License tok-r");
    assert.notEqual(sent[1]!.headers["signature"], sent[0]!.headers["signature"], "each hop carries its own signature");
  } finally {
    clearLicenseTokens();
  }
});

test("a token the server calls invalid is dropped, so it is not presented again", async () => {
  configure(true);
  clearLicenseTokens();
  rememberLicenseToken({ origin: "https://pub.example", resource: "/essays/*", token: "tok-dead", expiresAt: null });
  try {
    await withScript(
      [new Response("{}", { status: 401, headers: { "www-authenticate": 'License error="invalid_token"' } })],
      () => agentFetch("https://pub.example/essays/x"),
    );
    assert.equal(licenseTokenFor("https://pub.example/essays/x"), null);
    // The self-hosted form of the same refusal: a 402 whose verdict names it.
    rememberLicenseToken({ origin: "https://pub.example", resource: "/essays/*", token: "tok-dead2", expiresAt: null });
    await withScript(
      [new Response("{}", { status: 402, headers: { "x-naulon-verdict": "licence refused (invalid_token)" } })],
      () => agentFetch("https://pub.example/essays/x"),
    );
    assert.equal(licenseTokenFor("https://pub.example/essays/x"), null);
    // Any other refusal keeps the token: it is still a good licence.
    rememberLicenseToken({ origin: "https://pub.example", resource: "/essays/*", token: "tok-live", expiresAt: null });
    await withScript(
      [new Response("{}", { status: 402, headers: { "x-naulon-verdict": "licence refused (price_rose)" } })],
      () => agentFetch("https://pub.example/essays/x"),
    );
    assert.equal(licenseTokenFor("https://pub.example/essays/x"), "tok-live");
  } finally {
    clearLicenseTokens();
  }
});
