/**
 * A rotated-out signing key keeps verifying what it signed, and grants nothing new.
 *
 * Citation records are permanent, so the key set must keep publishing a key after it stops
 * signing. A key is usually retired because it may be exposed, so the gate's own re-read check
 * must not accept it: publishing and trusting are two different sets.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

const live = generateKeyPairSync("ed25519");
const retired = generateKeyPairSync("ed25519");
const retiredX = (retired.publicKey.export({ format: "jwk" }) as { x: string }).x;

process.env.EVENTS_PATH = join(tmpdir(), `naulon-retired-keys-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";
process.env.LICENSE_SIGNING_KEY = live.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
process.env.LICENSE_RETIRED_PUBLIC_KEYS = retiredX;

const { app } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { kidFor } = await import("@naulon/shared");

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function b64url(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

/** The same claims, signed by `key` under its own kid. */
function resign(jws: string, key: typeof retired): string {
  const claims = JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as unknown;
  const input = `${b64url({ alg: "EdDSA", typ: "JWT", kid: kidFor(key.publicKey) })}.${b64url(claims)}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), key.privateKey).toString("base64url")}`;
}

async function paidLicence(): Promise<string> {
  const first = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  const required = JSON.parse(Buffer.from(first.headers.get(PAYMENT_REQUIRED_HEADER)!, "base64").toString("utf8")) as {
    accepts: Array<{ amount: string; extra: { nonce: string } }>;
  };
  const a = required.accepts[0]!;
  const sig = buildMockSignature("0x1234567890abcdef1234567890abcdef12345678", a.amount, a.extra.nonce);
  const paid = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig } });
  assert.equal(paid.status, 200);
  return paid.headers.get("x-naulon-license")!;
}

test("the published key set carries the live key and the retired one", async () => {
  const body = (await (await app.request("/.well-known/naulon-jwks.json")).json()) as { keys: Array<{ kid: string; x: string }> };
  assert.deepEqual(
    body.keys.map((k) => k.kid),
    [kidFor(live.publicKey), kidFor(retired.publicKey)],
    "live first, then every retired key",
  );
  assert.equal(body.keys[1]!.x, retiredX);
});

test("a re-read signed by the retired key is refused, while the same claims under the live key read free", async () => {
  const jws = await paidLicence();
  const underLive = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": resign(jws, live) },
  });
  assert.equal(underLive.status, 200, "control: the re-signed shape is otherwise valid");

  const underRetired = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", "x-naulon-license": resign(jws, retired) },
  });
  assert.equal(underRetired.status, 402, "a retired key may verify old records, never unlock a read");
});
