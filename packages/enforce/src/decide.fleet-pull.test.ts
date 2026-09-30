import { test } from "node:test";
import assert from "node:assert/strict";
import { botAuthDirectoryBody, botAuthKeyFromSeed, signBotAuth, signBotAuthDirectory } from "@naulon/shared";
import { DirectoryCache } from "./botAuth.ts";
import { decide } from "./decide.ts";

// A runtime behind a crawler route serves the gate's own origin pull free: the gate already charged
// the read. Everything short of "the fleet's agent signed THIS path" is decided as usual.

const FLEET = "fleet.example";
const KEY = botAuthKeyFromSeed(Buffer.alloc(32, 7).toString("base64url"));
const OTHER = botAuthKeyFromSeed(Buffer.alloc(32, 8).toString("base64url"));

const directoryFetch = (async (input: string | URL | Request) => {
  const host = new URL(String(input)).host;
  const key = host === FLEET ? KEY : OTHER;
  const sig = signBotAuthDirectory(key, host);
  return new Response(botAuthDirectoryBody(key), {
    status: 200,
    headers: {
      "content-type": "application/http-message-signatures-directory+json",
      "signature-input": sig["signature-input"],
      signature: sig.signature,
    },
  });
}) as typeof fetch;

const ME = "pub_test";

const publisher = (fleetAgent?: string, fleetPublisher: string | undefined = ME) =>
  ({
    id: "pub_test",
    originUrl: "https://site.example",
    articlePrefixes: ["essays"],
    seoAllowlist: [],
    licenseIdentity: "did:web:test",
    suspended: false,
    ...(fleetAgent ? { fleetAgent } : {}),
    ...(fleetAgent && fleetPublisher ? { fleetPublisher } : {}),
  }) as any;

const quote = async () =>
  ({
    slug: "essays/x",
    kind: "read",
    title: "X",
    price: 5000,
    payees: [{ address: `0x${"a".repeat(40)}`, shareBps: 10000 }],
    extraLegs: [],
    coauthorSplit: false,
  }) as any;

function pull(
  opts: {
    agent?: string;
    key?: typeof KEY;
    signedPath?: string | null;
    requestPath?: string;
    /** The publisher the gate signed for; null = not covered by the signature. */
    signedFor?: string | null;
    /** The header value on the request, when it differs from what was signed. */
    sentFor?: string;
  } = {},
) {
  const requestPath = opts.requestPath ?? "/essays/x";
  const signedPath = opts.signedPath === undefined ? requestPath : opts.signedPath;
  const signedFor = opts.signedFor === undefined ? ME : opts.signedFor;
  const agent = opts.agent ?? FLEET;
  const h = signBotAuth({
    key: opts.key ?? KEY,
    authority: "site.example",
    tag: "web-bot-auth",
    agent,
    ...(signedPath !== null ? { path: signedPath } : {}),
    ...(signedFor !== null ? { headers: { "x-naulon-publisher": signedFor } } : {}),
  });
  const sent = opts.sentFor ?? signedFor ?? ME;
  return new Request(`https://site.example${requestPath}`, {
    headers: {
      "user-agent": "GPTBot/1.2",
      "signature-input": h["signature-input"],
      signature: h.signature,
      "signature-agent": h["signature-agent"]!,
      "x-naulon-publisher": sent,
    },
  });
}

const run = (raw: Request, fleetAgent?: string, fleetPublisher?: string) =>
  decide({
    raw,
    host: "site.example",
    path: new URL(raw.url).pathname,
    publisher: publisher(fleetAgent, fleetPublisher),
    now: Date.now(),
    quote,
    botAuthOpts: { fetchFn: directoryFetch, cache: new DirectoryCache() },
  });

test("the fleet's pull, signed over this path, is served free", async () => {
  const d = await run(pull(), FLEET);
  assert.equal(d.kind, "free");
  if (d.kind === "free") assert.equal(d.verdict, "fleet-pull");
});

test("the same pull on a runtime with no fleet agent (the gate itself) is charged", async () => {
  assert.equal((await run(pull())).kind, "payment-required");
});

test("a signature that does not cover the path is charged", async () => {
  assert.equal((await run(pull({ signedPath: null }), FLEET)).kind, "payment-required");
});

test("a fleet signature for another page does not open this one", async () => {
  assert.equal((await run(pull({ signedPath: "/essays/other", requestPath: "/essays/x" }), FLEET)).kind, "payment-required");
});

test("another operator's valid signature is charged", async () => {
  assert.equal((await run(pull({ agent: "other.example", key: OTHER }), FLEET)).kind, "payment-required");
});

test("a fleet pull decided for ANOTHER tenant whose origin is this site is charged", async () => {
  // Any tenant can name any site as its origin. Its reads are decided under its own policy.
  assert.equal((await run(pull({ signedFor: "someone-else" }), FLEET)).kind, "payment-required");
});

test("a publisher header the signature does not cover is not trusted", async () => {
  assert.equal((await run(pull({ signedFor: null, sentFor: ME }), FLEET)).kind, "payment-required");
});

test("a signed header swapped on the way is caught by the signature", async () => {
  assert.equal((await run(pull({ signedFor: "someone-else", sentFor: ME }), FLEET)).kind, "payment-required");
});

test("without its own publisher id a runtime serves nothing free", async () => {
  const d = await decide({
    raw: pull(),
    host: "site.example",
    path: "/essays/x",
    publisher: { ...publisher(FLEET), fleetPublisher: undefined },
    now: Date.now(),
    quote,
    botAuthOpts: { fetchFn: directoryFetch, cache: new DirectoryCache() },
  });
  assert.equal(d.kind, "payment-required");
});
