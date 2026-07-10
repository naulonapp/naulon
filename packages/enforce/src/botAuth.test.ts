/**
 * Web Bot Auth (RFC 9421 / draft-meunier-webbotauth-httpsig-protocol-00)
 * verifier — the structured-field subset, signature-base construction, key
 * directory handling, and the top-level verify.
 *
 * Interop facts pinned here (live-fetched 2026-07-04, do not re-derive):
 *  - Cloudflare's operational profile REJECTS the rev-00 dictionary form of
 *    Signature-Agent — deployed signers send a plain quoted string. We accept
 *    the quoted string as primary and tolerate the dictionary form.
 *  - keyid is the RFC 7638 JWK thumbprint (base64url, SHA-256).
 *  - tag="web-bot-auth" selects the signature among a Signature-Input that may
 *    carry several labels.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  buildSignatureBase,
  DirectoryCache,
  jwkThumbprint,
  parseSignatureAgent,
  parseSignatureHeader,
  parseSignatureInput,
  verifyBotAuth,
  verifyEd25519,
  type RequestFacts,
} from "./botAuth.ts";

// The CF-profile shape: one label, @authority covered, all required params.
const INPUT_CF = `sig1=("@authority");created=1735689600;expires=1735689660;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";tag="web-bot-auth"`;

test("parseSignatureInput: parses the CF-profile single label", () => {
  const entries = parseSignatureInput(INPUT_CF);
  assert.ok(entries);
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.label, "sig1");
  assert.deepEqual(e.components, [{ name: "@authority", raw: `"@authority"` }]);
  assert.equal(e.params.created, 1735689600);
  assert.equal(e.params.expires, 1735689660);
  assert.equal(e.params.keyid, "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
  assert.equal(e.params.tag, "web-bot-auth");
  // The verbatim member text is what @signature-params re-serializes to —
  // byte-exact reuse of what the signer signed, no canonical re-serialization.
  assert.equal(e.rawMemberText, INPUT_CF.slice("sig1=".length));
});

test("parseSignatureInput: component with a ;key= param (rev-00 vector shape)", () => {
  const v = `sig2=("@authority" "signature-agent";key="agent2");created=1;keyid="k";tag="web-bot-auth"`;
  const entries = parseSignatureInput(v);
  assert.ok(entries);
  assert.deepEqual(entries[0]!.components, [
    { name: "@authority", raw: `"@authority"` },
    { name: "signature-agent", key: "agent2", raw: `"signature-agent";key="agent2"` },
  ]);
});

test("parseSignatureInput: multiple labels both surface", () => {
  const v = `other=("@authority");tag="not-ours", sig1=("@authority");created=2;keyid="k";tag="web-bot-auth"`;
  const entries = parseSignatureInput(v);
  assert.ok(entries);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.params.tag, "web-bot-auth");
  assert.equal(entries[1]!.rawMemberText, `("@authority");created=2;keyid="k";tag="web-bot-auth"`);
});

test("parseSignatureInput: garbage returns null, never throws", () => {
  assert.equal(parseSignatureInput(`sig1=(@authority`), null);
  assert.equal(parseSignatureInput(`sig1="not-a-list"`), null);
  assert.equal(parseSignatureInput(``), null);
});

test("parseSignatureHeader: byte-sequence per label", () => {
  const sig = Buffer.from("hello signature bytes");
  const v = `sig1=:${sig.toString("base64")}:`;
  const parsed = parseSignatureHeader(v);
  assert.ok(parsed);
  assert.deepEqual(Buffer.from(parsed.get("sig1")!), sig);
});

test("parseSignatureHeader: malformed byte sequence returns null", () => {
  assert.equal(parseSignatureHeader(`sig1=:not/base64!!:`), null);
  assert.equal(parseSignatureHeader(`sig1="quoted-not-bytes"`), null);
});

test("parseSignatureAgent: CF-profile quoted string", () => {
  assert.equal(
    parseSignatureAgent(`"https://signature-agent.test"`),
    "https://signature-agent.test",
  );
});

test("parseSignatureAgent: rev-00 dictionary form tolerated", () => {
  assert.equal(
    parseSignatureAgent(`agent2="https://signature-agent.test"`),
    "https://signature-agent.test",
  );
});

test("parseSignatureAgent: bare host without scheme is normalized to https", () => {
  // The architecture drafts allowed a bare host; normalize rather than refuse.
  assert.equal(parseSignatureAgent(`"chatgpt.com"`), "https://chatgpt.com");
});

test("parseSignatureAgent: garbage returns null", () => {
  assert.equal(parseSignatureAgent(``), null);
  assert.equal(parseSignatureAgent(`not "quoted`), null);
});

/* ------------------------------------------------------------------ *
 * Signature base + Ed25519 — pinned by the protocol draft's Appendix C
 * Ed25519 vector (key = RFC 9421 Appendix B.1.4).
 * ------------------------------------------------------------------ */

// RFC 9421 B.1.4 Ed25519 public key.
const VECTOR_X = "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs";
// Its RFC 7638 thumbprint — the draft uses it as the keyid.
const VECTOR_KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";

const VECTOR_PARAMS = `("@authority" "signature-agent";key="agent2");created=1735689600;keyid="${VECTOR_KEYID}";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"`;

const VECTOR_BASE = [
  `"@authority": example.com`,
  `"signature-agent";key="agent2": "https://signature-agent.test"`,
  `"@signature-params": ${VECTOR_PARAMS}`,
].join("\n");

const VECTOR_SIG =
  "RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==";

test("jwkThumbprint: reproduces the draft vector keyid from the RFC 9421 key", () => {
  assert.equal(jwkThumbprint(VECTOR_X), VECTOR_KEYID);
});

test("buildSignatureBase: reproduces the draft vector base byte-exactly", () => {
  const entries = parseSignatureInput(`sig2=${VECTOR_PARAMS}`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "example.com",
    method: "GET",
    path: "/",
    targetUri: "https://example.com/",
    headers: { "signature-agent": `agent2="https://signature-agent.test"` },
  });
  assert.equal(base, VECTOR_BASE);
});

test("verifyEd25519: draft vector signature verifies over the vector base", () => {
  const ok = verifyEd25519(VECTOR_BASE, new Uint8Array(Buffer.from(VECTOR_SIG, "base64")), VECTOR_X);
  assert.equal(ok, true);
});

test("verifyEd25519: tampered base fails", () => {
  const ok = verifyEd25519(
    VECTOR_BASE.replace("example.com", "evil.example"),
    new Uint8Array(Buffer.from(VECTOR_SIG, "base64")),
    VECTOR_X,
  );
  assert.equal(ok, false);
});

test("buildSignatureBase: derived components serialize per RFC 9421", () => {
  const entries = parseSignatureInput(`sig1=("@authority" "@method" "@path" "@target-uri");created=1;keyid="k";tag="web-bot-auth"`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "toll.example",
    method: "get",
    path: "/essays/one",
    targetUri: "https://toll.example/essays/one",
    headers: {},
  });
  assert.ok(base);
  const lines = base.split("\n");
  assert.equal(lines[0], `"@authority": toll.example`);
  assert.equal(lines[1], `"@method": GET`);
  assert.equal(lines[2], `"@path": /essays/one`);
  assert.equal(lines[3], `"@target-uri": https://toll.example/essays/one`);
});

test("buildSignatureBase: plain header component uses the raw trimmed value", () => {
  const entries = parseSignatureInput(`sig1=("@authority" "signature-agent");created=1;keyid="k";tag="web-bot-auth"`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "toll.example",
    method: "GET",
    path: "/",
    targetUri: "https://toll.example/",
    headers: { "signature-agent": `  "https://signer.test"  ` },
  });
  assert.ok(base);
  assert.equal(base.split("\n")[1], `"signature-agent": "https://signer.test"`);
});

test("buildSignatureBase: unsupported derived component returns null", () => {
  const entries = parseSignatureInput(`sig1=("@authority" "@query");created=1;keyid="k";tag="web-bot-auth"`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "toll.example",
    method: "GET",
    path: "/",
    targetUri: "https://toll.example/",
    headers: {},
  });
  assert.equal(base, null);
});

test("buildSignatureBase: covered header absent from the request returns null", () => {
  const entries = parseSignatureInput(`sig1=("signature-agent");created=1;keyid="k";tag="web-bot-auth"`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "toll.example",
    method: "GET",
    path: "/",
    targetUri: "https://toll.example/",
    headers: {},
  });
  assert.equal(base, null);
});

test("buildSignatureBase: ;key= member missing from the dictionary returns null", () => {
  const entries = parseSignatureInput(`sig1=("signature-agent";key="nope");created=1;keyid="k";tag="web-bot-auth"`);
  assert.ok(entries);
  const base = buildSignatureBase(entries[0]!, {
    authority: "toll.example",
    method: "GET",
    path: "/",
    targetUri: "https://toll.example/",
    headers: { "signature-agent": `agent2="https://signer.test"` },
  });
  assert.equal(base, null);
});

/* ------------------------------------------------------------------ *
 * Directory cache + top-level verifyBotAuth (fetch injected — the live
 * walk exercises real HTTP).
 * ------------------------------------------------------------------ */

// A real Ed25519 signer for fixtures: fresh keypair per test run.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SIGNER_X = publicKey.export({ format: "jwk" }).x as string;
const SIGNER_KEYID = jwkThumbprint(SIGNER_X);
const AGENT_HOST = "signer.test";
const DIRECTORY_BODY = JSON.stringify({
  keys: [{ kty: "OKP", crv: "Ed25519", x: SIGNER_X, use: "sig" }],
});
const DIR_CONTENT_TYPE = "application/http-message-signatures-directory+json";

/** Build a signed request's facts against `authority`, CF profile shape. */
function signedFacts(over: {
  authority?: string;
  signAuthority?: string;
  created?: number;
  expires?: number;
  tag?: string;
  keyid?: string;
  agent?: string;
  breakSig?: boolean;
  components?: string;
} = {}): RequestFacts {
  const now = Math.floor(Date.now() / 1000);
  const authority = over.authority ?? "toll.example";
  const signAuthority = over.signAuthority ?? authority;
  const created = over.created ?? now - 5;
  const expires = over.expires ?? now + 55;
  const tag = over.tag ?? "web-bot-auth";
  const keyid = over.keyid ?? SIGNER_KEYID;
  const agentHeader = over.agent ?? `"https://${AGENT_HOST}"`;
  const components = over.components ?? `("@authority")`;
  const member = `${components};created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";tag="${tag}"`;
  const parsed = parseSignatureInput(`sig1=${member}`);
  if (!parsed) throw new Error("fixture Signature-Input failed to parse");
  const base = buildSignatureBase(parsed[0]!, {
    authority: signAuthority,
    method: "GET",
    path: "/essays/one",
    targetUri: `https://${signAuthority}/essays/one`,
    headers: { "signature-agent": agentHeader },
  });
  if (base === null) throw new Error("fixture base failed to build");
  let sig = cryptoSign(null, Buffer.from(base), privateKey);
  if (over.breakSig) sig = Buffer.from(sig.map((b, i) => (i === 3 ? b ^ 0xff : b)));
  return {
    authority,
    method: "GET",
    path: "/essays/one",
    targetUri: `https://${authority}/essays/one`,
    headers: {
      "user-agent": "SomeBot/1.0",
      "signature-agent": agentHeader,
      "signature-input": `sig1=${member}`,
      signature: `sig1=:${sig.toString("base64")}:`,
    },
  };
}

/** fetchFn stub serving DIRECTORY_BODY for the signer's well-known URL. */
function directoryFetch(counter: { n: number }, over: { contentType?: string; body?: string } = {}) {
  return async (input: string | URL | Request): Promise<Response> => {
    counter.n++;
    const url = String(input);
    assert.equal(url, `https://${AGENT_HOST}/.well-known/http-message-signatures-directory`);
    return new Response(over.body ?? DIRECTORY_BODY, {
      status: 200,
      headers: { "content-type": over.contentType ?? DIR_CONTENT_TYPE },
    });
  };
}

test("DirectoryCache: positive entries expire after their TTL", () => {
  let t = 0;
  const cache = new DirectoryCache({ posTtlMs: 100, negTtlMs: 50, cap: 4, now: () => t });
  cache.set("https://a.test", new Map([["k", "x"]]));
  assert.ok(cache.get("https://a.test"));
  t = 101;
  assert.equal(cache.get("https://a.test"), undefined);
});

test("DirectoryCache: negative entries expire after the (shorter) negative TTL", () => {
  let t = 0;
  const cache = new DirectoryCache({ posTtlMs: 100, negTtlMs: 50, cap: 4, now: () => t });
  cache.set("https://a.test", null);
  assert.equal(cache.get("https://a.test"), null);
  t = 51;
  assert.equal(cache.get("https://a.test"), undefined);
});

test("DirectoryCache: LRU evicts the least-recently-used entry at cap", () => {
  const cache = new DirectoryCache({ posTtlMs: 1000, negTtlMs: 1000, cap: 2, now: () => 0 });
  cache.set("https://a.test", new Map());
  cache.set("https://b.test", new Map());
  cache.get("https://a.test"); // refresh a
  cache.set("https://c.test", new Map()); // evicts b
  assert.ok(cache.get("https://a.test"));
  assert.equal(cache.get("https://b.test"), undefined);
  assert.ok(cache.get("https://c.test"));
});

test("verifyBotAuth: no signature headers → absent", async () => {
  const out = await verifyBotAuth(
    { authority: "toll.example", method: "GET", path: "/", targetUri: "https://toll.example/", headers: { "user-agent": "Mozilla/5.0" } },
    { fetchFn: async () => { throw new Error("must not fetch"); } },
  );
  assert.deepEqual(out, { status: "absent" });
});

test("verifyBotAuth: alien tag only → absent (not our protocol)", async () => {
  const facts = signedFacts({ tag: "some-other-tag" });
  const out = await verifyBotAuth(facts, { fetchFn: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(out, { status: "absent" });
});

test("verifyBotAuth: happy path verifies and caches the directory", async () => {
  const counter = { n: 0 };
  const cache = new DirectoryCache();
  const opts = { fetchFn: directoryFetch(counter), cache };
  const out1 = await verifyBotAuth(signedFacts(), opts);
  assert.deepEqual(out1, { status: "verified", agent: { agent: AGENT_HOST, keyid: SIGNER_KEYID } });
  const out2 = await verifyBotAuth(signedFacts(), opts);
  assert.equal(out2.status, "verified");
  assert.equal(counter.n, 1); // second verify served from cache
});

test("verifyBotAuth: expired signature → invalid", async () => {
  const now = Math.floor(Date.now() / 1000);
  const facts = signedFacts({ created: now - 120, expires: now - 60 });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
  assert.match((out as { reason: string }).reason, /expired/);
});

test("verifyBotAuth: created in the future beyond skew → invalid", async () => {
  const now = Math.floor(Date.now() / 1000);
  const facts = signedFacts({ created: now + 3600, expires: now + 7200 });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: signature over a different authority → invalid", async () => {
  const facts = signedFacts({ signAuthority: "other.example" });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: tampered signature bytes → invalid", async () => {
  const facts = signedFacts({ breakSig: true });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: neither @authority nor @target-uri covered → invalid", async () => {
  const facts = signedFacts({ components: `("signature-agent")` });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: unknown keyid refetches the directory once, then invalid", async () => {
  const counter = { n: 0 };
  const cache = new DirectoryCache();
  const opts = { fetchFn: directoryFetch(counter), cache };
  await verifyBotAuth(signedFacts(), opts); // primes the cache
  const facts = signedFacts({ keyid: "bm90LWEtcmVhbC1rZXlpZC10aHVtYnByaW50LXZhbHVl" });
  const out = await verifyBotAuth(facts, opts);
  assert.equal(out.status, "invalid");
  assert.match((out as { reason: string }).reason, /keyid/);
  assert.equal(counter.n, 2); // primed fetch + rotation refetch
});

test("verifyBotAuth: directory fetch failure → unverified (fail-open) and negative-cached", async () => {
  let n = 0;
  const cache = new DirectoryCache();
  const fetchFn = async (): Promise<Response> => {
    n++;
    throw new Error("network down");
  };
  const out1 = await verifyBotAuth(signedFacts(), { fetchFn, cache });
  assert.equal(out1.status, "unverified");
  const out2 = await verifyBotAuth(signedFacts(), { fetchFn, cache });
  assert.equal(out2.status, "unverified");
  assert.equal(n, 1); // negative cache absorbed the second attempt
});

test("verifyBotAuth: http:// directory refused without the test flag", async () => {
  const facts = signedFacts({ agent: `"http://${AGENT_HOST}"` });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: IP-literal directory host refused (SSRF guard)", async () => {
  const facts = signedFacts({ agent: `"https://10.0.0.7"` });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
});

test("verifyBotAuth: localhost + http allowed only under allowInsecureHttp", async () => {
  let fetched = "";
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    fetched = String(input);
    return new Response(DIRECTORY_BODY, { status: 200, headers: { "content-type": DIR_CONTENT_TYPE } });
  };
  const facts = signedFacts({ agent: `"http://localhost:9999"` });
  // Re-sign is not needed: agent header is inside the signed base, so build
  // fresh facts signed WITH that agent header.
  const out = await verifyBotAuth(facts, { fetchFn, allowInsecureHttp: true, cache: new DirectoryCache() });
  assert.equal(out.status, "verified");
  assert.equal(fetched, "http://localhost:9999/.well-known/http-message-signatures-directory");
});

test("verifyBotAuth: wrong directory content-type → unverified (fail-open)", async () => {
  const facts = signedFacts();
  const out = await verifyBotAuth(facts, {
    fetchFn: directoryFetch({ n: 0 }, { contentType: "text/html" }),
    cache: new DirectoryCache(),
  });
  assert.equal(out.status, "unverified");
});

test("verifyBotAuth: unparsable directory JSON → unverified (fail-open)", async () => {
  const out = await verifyBotAuth(signedFacts(), {
    fetchFn: directoryFetch({ n: 0 }, { body: "<html>not a jwks</html>" }),
    cache: new DirectoryCache(),
  });
  assert.equal(out.status, "unverified");
});

test("verifyBotAuth: validity window over the draft's 24h max → invalid (replay bound)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const facts = signedFacts({ created: now - 5, expires: now + 60 * 60 * 25 });
  const out = await verifyBotAuth(facts, { fetchFn: directoryFetch({ n: 0 }) });
  assert.equal(out.status, "invalid");
  assert.match((out as { reason: string }).reason, /window/);
});
