/**
 * WBA slice 3, the dogfood proof at unit level: OUR signer (shared/botAuthSign)
 * against OUR verifier (tollgate/botAuth) — sign a request, verify it exactly
 * the way the gate verifies inbound traffic, including the directory fetch and
 * the directory's own response signature. Most implementers test against
 * Cloudflare's debug endpoint; we own both ends and pin them to each other.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botAuthDirectoryBody,
  botAuthKeyFromSeed,
  botAuthThumbprint,
  signBotAuth,
  signBotAuthDirectory,
} from "@naulon/shared";
import { DirectoryCache, jwkThumbprint, verifyBotAuth, type RequestFacts } from "./botAuth.ts";

const SEED = Buffer.alloc(32, 42).toString("base64url");
const KEY = botAuthKeyFromSeed(SEED);
const AGENT = "signer.example";
const DIR_URL = `https://${AGENT}/.well-known/http-message-signatures-directory`;

/** Serve OUR directory the way the gate route does (signed response). */
function directoryFetch(over: { unsignedResponse?: boolean; wrongKeyBody?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    assert.equal(url, DIR_URL);
    const body = over.wrongKeyBody
      ? botAuthDirectoryBody(botAuthKeyFromSeed(Buffer.alloc(32, 9).toString("base64url")))
      : botAuthDirectoryBody(KEY);
    const headers: Record<string, string> = {
      "content-type": "application/http-message-signatures-directory+json",
    };
    if (!over.unsignedResponse) {
      const sig = signBotAuthDirectory(KEY, AGENT);
      headers["signature-input"] = sig["signature-input"];
      headers["signature"] = sig.signature;
    }
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
}

function signedFacts(over: { authority?: string; tamper?: boolean } = {}): RequestFacts {
  const authority = over.authority ?? "gate.example";
  const h = signBotAuth({ key: KEY, authority, tag: "web-bot-auth", agent: AGENT });
  let sig = h.signature;
  if (over.tamper) sig = sig.replace(/:.{4}/, ":AAAA");
  return {
    authority: "gate.example",
    method: "GET",
    path: "/essays/on-stillness",
    targetUri: "http://gate.example/essays/on-stillness",
    headers: {
      "signature-input": h["signature-input"],
      signature: sig,
      "signature-agent": h["signature-agent"]!,
      "user-agent": "naulon-wayfarer/0.1",
    },
  };
}

test("signer and verifier agree on the RFC 7638 thumbprint", () => {
  assert.equal(botAuthThumbprint(KEY.x), jwkThumbprint(KEY.x));
});

test("a signed request round-trips: our signer → our verifier → verified identity", async () => {
  const outcome = await verifyBotAuth(signedFacts(), {
    fetchFn: directoryFetch(),
    cache: new DirectoryCache(),
  });
  assert.deepEqual(outcome, { status: "verified", agent: { agent: AGENT, keyid: KEY.keyid } });
});

test("the round-trip verifies the directory's own response signature (unsigned still accepted, wrong keys rejected)", async () => {
  // Absent directory signature → accepted on TLS binding (interop stance).
  const unsigned = await verifyBotAuth(signedFacts(), {
    fetchFn: directoryFetch({ unsignedResponse: true }),
    cache: new DirectoryCache(),
  });
  assert.equal(unsigned.status, "verified");
  // Directory publishing DIFFERENT keys: our signed response no longer matches
  // → directory unusable → fail-open unverified (not a masquerade flag).
  const wrongKeys = await verifyBotAuth(signedFacts(), {
    fetchFn: directoryFetch({ wrongKeyBody: true }),
    cache: new DirectoryCache(),
  });
  assert.equal(wrongKeys.status, "unverified");
});

test("a tampered signature from our own signer is invalid (masquerade telemetry), never verified", async () => {
  const outcome = await verifyBotAuth(signedFacts({ tamper: true }), {
    fetchFn: directoryFetch(),
    cache: new DirectoryCache(),
  });
  assert.equal(outcome.status, "invalid");
});

test("a signature for another authority does not verify here (no cross-host replay)", async () => {
  const outcome = await verifyBotAuth(signedFacts({ authority: "other.example" }), {
    fetchFn: directoryFetch(),
    cache: new DirectoryCache(),
  });
  assert.equal(outcome.status, "invalid");
});
