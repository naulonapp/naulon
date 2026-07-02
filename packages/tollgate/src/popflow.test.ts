/**
 * End-to-end holder-of-key flow (P5) through the wired gate, with LICENSE_POP on.
 * An agent pays, gets a cnf-bound license, and proves possession of the payer
 * wallet to re-read free. A re-read with no proof — or a captured token replayed
 * by someone without the key — falls through to 402, never free.
 *
 * Env is set BEFORE importing the app so config binds mock mode + PoP; the origin
 * fetch is stubbed so the success path resolves without a live backend.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-popflow-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.LICENSE_POP = "true";
process.env.LICENSE_POP_WINDOW_SECONDS = "120";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { popMessage } = await import("@naulon/shared");

// The agent's wallet (derived, not a hardcoded key). Its address is the payer.
const ACCOUNT = privateKeyToAccount(`0x${createHash("sha256").update("naulon-popflow-agent").digest("hex")}`);
const PAYER = ACCOUNT.address;

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function payload(jws: string): { aud: string; jti: string; sub: string; cnf?: { "naulon:addr": string }; naulon: { slug: string } } {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));
}
function decodeJson(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

/** Pay for an essay and return the minted (cnf-bound) license JWS. */
async function payForLicense(slug: string): Promise<string> {
  const first = await app.request(`/essays/${slug}`, { headers: { "x-naulon-agent": "agent" } });
  assert.equal(first.status, 402);
  const accepts = (decodeJson(first.headers.get(PAYMENT_REQUIRED_HEADER)!).accepts as Array<{
    amount: string;
    extra: { nonce: string };
  }>)[0]!;
  const sig = buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce);
  const paid = await app.request(`/essays/${slug}`, {
    headers: { "x-naulon-agent": "agent", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(paid.status, 200);
  return paid.headers.get("x-naulon-license")!;
}

/** Build a holder-of-key proof header for a license, signed by the payer wallet. */
async function proofFor(jws: string, slug: string, nonce = randomBytes(16).toString("hex")): Promise<string> {
  const { aud, jti } = payload(jws);
  const ts = Math.floor(Date.now() / 1000);
  const sig = await ACCOUNT.signMessage({ message: popMessage({ aud, jti, slug, ts, nonce }) });
  return `${ts}.${nonce}.${sig}`;
}

test("LICENSE_POP mints a license bound to the payer wallet (cnf)", async () => {
  const jws = await payForLicense("on-stillness");
  const claims = payload(jws);
  assert.equal(claims.cnf?.["naulon:addr"], PAYER.toLowerCase());
  assert.equal(claims.sub, PAYER);
});

test("re-read WITH a valid proof-of-possession is served FREE", async () => {
  const jws = await payForLicense("on-stillness");
  const res = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "agent", "x-naulon-license": jws, "x-naulon-proof": await proofFor(jws, "on-stillness") },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /reread/);
});

test("re-read of a cnf-bound license with NO proof falls through to 402 (not a bearer right)", async () => {
  const jws = await payForLicense("on-stillness");
  const res = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "agent", "x-naulon-license": jws },
  });
  assert.equal(res.status, 402);
});

test("a captured token + a proof for the WRONG wallet is rejected (leak-replay closed)", async () => {
  const jws = await payForLicense("the-naulon");
  const attacker = privateKeyToAccount(`0x${createHash("sha256").update("thief").digest("hex")}`);
  const { aud, jti } = payload(jws);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const sig = await attacker.signMessage({ message: popMessage({ aud, jti, slug: "the-naulon", ts, nonce }) });
  const res = await app.request("/essays/the-naulon", {
    headers: { "x-naulon-agent": "agent", "x-naulon-license": jws, "x-naulon-proof": `${ts}.${nonce}.${sig}` },
  });
  assert.equal(res.status, 402);
});

test("a proof is single-use — replaying the same proof is rejected", async () => {
  const jws = await payForLicense("the-river-and-the-name");
  const proof = await proofFor(jws, "the-river-and-the-name");
  const first = await app.request("/essays/the-river-and-the-name", {
    headers: { "x-naulon-agent": "agent", "x-naulon-license": jws, "x-naulon-proof": proof },
  });
  assert.equal(first.status, 200);
  const replay = await app.request("/essays/the-river-and-the-name", {
    headers: { "x-naulon-agent": "agent", "x-naulon-license": jws, "x-naulon-proof": proof },
  });
  assert.equal(replay.status, 402);
});
