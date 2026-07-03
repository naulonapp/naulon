/**
 * Web Bot Auth through the whole gate: a signed request's verified identity
 * drives the crawler policy (allow frees, block refuses, unlisted pays), a
 * tampered signature fails OPEN to the UA path but leaves masquerade telemetry
 * (`sigInvalid`), and unsigned traffic is byte-identical to the pre-WBA gate.
 *
 * The directory fetch rides the same stubbed global fetch the origin proxy
 * uses — https://<signer>/.well-known/http-message-signatures-directory serves
 * a JWKS for the test keypair; everything else serves origin HTML.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { ObservationEvent } from "@naulon/shared";

const OBS_PATH = join(tmpdir(), `naulon-wba-obs-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.EVENTS_PATH = join(tmpdir(), `naulon-wba-events-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { jwkThumbprint, buildSignatureBase, parseSignatureInput } = await import("./botAuth.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SIGNER_X = publicKey.export({ format: "jwk" }).x as string;
const SIGNER_KEYID = jwkThumbprint(SIGNER_X);
const DIRECTORY_BODY = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: SIGNER_X }] });

const HOST = "wba.example";
const AUTHOR_WALLET = walletAddress("0x0000000000000000000000000000000000000001");
const PUB: PublisherConfig = {
  id: "wba-pub",
  originUrl: "http://origin-wba.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      return { slug, title: `T: ${slug}`, contributors: [{ authorId: "a", wallet: AUTHOR_WALLET }] };
    },
  },
  licenseIdentity: "naulon:wba.example",
  crawlerPolicy: { allow: ["goodsigner.test"], block: ["badsigner.test"], charge: [] },
};

const app = createApp({ async resolve(h) { return h === HOST ? PUB : undefined; } });

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/.well-known/http-message-signatures-directory")) {
      return new Response(DIRECTORY_BODY, {
        status: 200,
        headers: { "content-type": "application/http-message-signatures-directory+json" },
      });
    }
    return new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Sign a GET for `path` as `agentHost`, CF profile shape (@authority only). */
function signedHeaders(agentHost: string, path: string, over: { breakSig?: boolean; ua?: string } = {}): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const agentHeader = `"https://${agentHost}"`;
  const member = `("@authority");created=${now - 2};expires=${now + 58};keyid="${SIGNER_KEYID}";alg="ed25519";tag="web-bot-auth"`;
  const entry = parseSignatureInput(`sig1=${member}`)![0]!;
  const base = buildSignatureBase(entry, {
    authority: HOST,
    method: "GET",
    path,
    targetUri: `http://${HOST}${path}`,
    headers: { "signature-agent": agentHeader },
  })!;
  let sig = cryptoSign(null, Buffer.from(base), privateKey);
  if (over.breakSig) sig = Buffer.from(sig.map((b, i) => (i === 5 ? b ^ 0xff : b)));
  return {
    host: HOST,
    "user-agent": over.ua ?? "Mozilla/5.0 Firefox/128.0",
    accept: "text/html",
    "signature-agent": agentHeader,
    "signature-input": `sig1=${member}`,
    signature: `sig1=:${sig.toString("base64")}:`,
  };
}

async function obsFor(slug: string): Promise<ObservationEvent> {
  for (let i = 0; i < 40; i++) {
    try {
      const rows = (await readFile(OBS_PATH, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ObservationEvent);
      const hit = rows.findLast((r) => r.slug === slug);
      if (hit) return hit;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no observation for slug ${slug}`);
}

test("verified unlisted signer pays: 402 even behind a browser-shaped UA", async () => {
  const res = await app.request("/essays/wba-charged", { headers: signedHeaders("chargedsigner.test", "/essays/wba-charged") });
  assert.equal(res.status, 402, "cryptographic identity outranks the browser-shaped UA (dodge hole closed)");
  const obs = await obsFor("wba-charged");
  assert.equal(obs.verified, true);
  assert.equal(obs.verifiedAgent, "chargedsigner.test");
  assert.match(obs.classifyReason ?? "", /verified web-bot-auth/);
});

test("verified allow-listed signer reads free — the spoof-proof allowlist", async () => {
  const res = await app.request("/essays/wba-allowed", { headers: signedHeaders("goodsigner.test", "/essays/wba-allowed") });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /verified agent/);
  const obs = await obsFor("wba-allowed");
  assert.equal(obs.verified, true);
  assert.equal(obs.verdict, "served-free");
});

test("verified blocked signer is refused 403 — payment cannot buy past it, UA innocence doesn't help", async () => {
  const res = await app.request("/essays/wba-blocked", {
    headers: { ...signedHeaders("badsigner.test", "/essays/wba-blocked"), "x-payment": "deadbeef" },
  });
  assert.equal(res.status, 403, "verified-blocked operator cannot dodge by UA rotation nor buy past the block");
  const obs = await obsFor("wba-blocked");
  assert.equal(obs.verdict, "blocked");
  assert.equal(obs.verifiedAgent, "badsigner.test");
});

test("tampered signature fails OPEN to the UA path, flagged as masquerade telemetry", async () => {
  const res = await app.request("/essays/wba-tampered", {
    headers: signedHeaders("chargedsigner.test", "/essays/wba-tampered", { breakSig: true }),
  });
  assert.equal(res.status, 200, "invalid signature + browser-shaped UA → human path (fail-open)");
  const obs = await obsFor("wba-tampered");
  assert.equal(obs.sigInvalid, true);
  assert.equal(obs.verified, undefined);
});

test("unsigned request: observation carries no WBA fields (regression)", async () => {
  const res = await app.request("/essays/wba-plain", {
    headers: { host: HOST, "user-agent": "Mozilla/5.0 Firefox/128.0", accept: "text/html" },
  });
  assert.equal(res.status, 200);
  const obs = await obsFor("wba-plain");
  assert.equal(obs.verified, undefined);
  assert.equal(obs.sigInvalid, undefined);
  assert.equal(obs.verifiedAgent, undefined);
});
