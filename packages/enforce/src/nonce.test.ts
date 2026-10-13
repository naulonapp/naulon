import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeNonce, issueNonce, type NonceBinding } from "./nonce.ts";

const binding: NonceBinding = {
  amount: "1000",
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:5042002",
};

test("a freshly issued nonce is accepted once", async () => {
  const now = 1_000_000;
  const nonce = issueNonce(binding, now);
  assert.deepEqual(await consumeNonce(nonce, binding, now), { ok: true });
});

test("replay is rejected", async () => {
  const now = 1_000_000;
  const nonce = issueNonce(binding, now);
  assert.equal((await consumeNonce(nonce, binding, now)).ok, true);
  const second = await consumeNonce(nonce, binding, now);
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /replay/);
});

test("an expired nonce is rejected", async () => {
  const issuedAt = 0;
  const nonce = issueNonce(binding, issuedAt);
  // default TTL is 300s; well past it
  const result = await consumeNonce(nonce, binding, issuedAt + 301_000);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /expired/);
});

test("a nonce minted for one binding can't satisfy another (price swap)", async () => {
  const now = 2_000_000;
  const cheap = issueNonce(binding, now);
  const pricier: NonceBinding = { ...binding, amount: "5000" };
  const result = await consumeNonce(cheap, pricier, now);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /signature/);
});

test("a tampered nonce is rejected", async () => {
  const now = 3_000_000;
  const nonce = issueNonce(binding, now);
  const tampered = nonce.slice(0, -1) + (nonce.endsWith("a") ? "b" : "a");
  assert.equal((await consumeNonce(tampered, binding, now)).ok, false);
});

test("a malformed nonce is rejected, not thrown", async () => {
  assert.equal((await consumeNonce("not-a-nonce", binding, 0)).ok, false);
});

// Edge runtimes (Cloudflare Workers) refuse random values outside a request handler, so loading
// this module must not mint a secret. Each case runs in a fresh process because the secret is
// module state.
const NONCE_PATH = new URL("./nonce.ts", import.meta.url).pathname;
const WARNING = /TOLLGATE_SECRET not set/;

async function runIsolated(script: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, NODE_ENV: "test", PAYMENT_MODE: "mock", ...env },
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const issueTwice = `
  const { issueNonce } = await import(${JSON.stringify(NONCE_PATH)});
  console.error("--loaded--");
  const b = { amount: "1", payTo: "0x${"1".repeat(40)}", network: "eip155:5042002" };
  issueNonce(b, 1); issueNonce(b, 2);
`;

test("loading the module mints no secret; the first issued nonce does, once", async () => {
  const run = await runIsolated(issueTwice, {});
  assert.equal(run.status, 0, run.stderr);
  const [beforeLoad, afterLoad] = run.stderr.split("--loaded--") as [string, string];
  assert.doesNotMatch(beforeLoad, WARNING);
  assert.equal(afterLoad.match(new RegExp(WARNING, "g"))?.length, 1);
});

test("an empty TOLLGATE_SECRET is unset, never an empty HMAC key", async () => {
  const run = await runIsolated(issueTwice, { TOLLGATE_SECRET: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr.split("--loaded--")[1] ?? "", WARNING);
});

test("instances sharing TOLLGATE_SECRET accept each other's nonces", async () => {
  const secret = "s".repeat(64);
  const b = `{ amount: "1", payTo: "0x${"1".repeat(40)}", network: "eip155:5042002" }`;
  const issued = await runIsolated(
    `const { issueNonce } = await import(${JSON.stringify(NONCE_PATH)}); process.stdout.write(issueNonce(${b}, 1000));`,
    { TOLLGATE_SECRET: secret },
  );
  assert.equal(issued.status, 0, issued.stderr);
  assert.doesNotMatch(issued.stderr, WARNING);
  const consumed = await runIsolated(
    `const { consumeNonce } = await import(${JSON.stringify(NONCE_PATH)}); process.stdout.write(JSON.stringify(await consumeNonce(${JSON.stringify(issued.stdout)}, ${b}, 1000)));`,
    { TOLLGATE_SECRET: secret },
  );
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.deepEqual(JSON.parse(consumed.stdout), { ok: true });
});
