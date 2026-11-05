import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import { fileStateStore, memoryStateStore, type GateStateStore } from "@naulon/shared";
import { bootstrapSecrets, describeBootstrap, secp256k1PrivateKey } from "./bootstrap.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "naulon-state-"));

for (const [name, make] of [
  ["memory", () => memoryStateStore()],
  ["file", () => fileStateStore(fresh())],
] as const) {
  test(`${name}: the first write wins and every later one reads it`, async () => {
    const s: GateStateStore = make();
    assert.equal(await s.get("secret:a"), null);
    assert.equal(await s.createIfAbsent("secret:a", "one"), "one");
    assert.equal(await s.createIfAbsent("secret:a", "two"), "one");
    await s.put("secret:a", "three");
    assert.equal(await s.get("secret:a"), "three");
    await s.delete("secret:a");
    assert.equal(await s.get("secret:a"), null);
  });

  test(`${name}: list returns one prefix, in key order`, async () => {
    const s = make();
    await s.put("credential:b", "2");
    await s.put("credential:a", "1");
    await s.put("credentialx:c", "x");
    await s.put("owner", "o");
    assert.deepEqual(await s.list("credential:"), [
      { key: "credential:a", value: "1" },
      { key: "credential:b", value: "2" },
    ]);
  });

  test(`${name}: a key outside the alphabet is refused before it touches storage`, async () => {
    const s = make();
    for (const bad of ["", "../owner", "Secret", "a/b", "a b", "x".repeat(200)]) {
      await assert.rejects(s.put(bad, "v"), /invalid state key/, bad);
    }
  });
}

test("file: fifty racing writers agree on one value, and no temp file is left", async () => {
  const dir = fresh();
  const stores = Array.from({ length: 5 }, () => fileStateStore(dir));
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => stores[i % 5]!.createIfAbsent("secret:race", `v${i}`)));
  assert.equal(new Set(results).size, 1);
  assert.deepEqual(readdirSync(dir), ["secret~race.v"]);
});

test("file: the directory is private and so is every value", async () => {
  const dir = join(fresh(), "data");
  const s = fileStateStore(dir);
  await s.createIfAbsent("secret:a", "x");
  await s.put("secret:b", "y");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
});

test("first boot generates each secret once, and a second boot restores the same ones", async () => {
  const store = memoryStateStore();
  const a: NodeJS.ProcessEnv = {};
  const first = await bootstrapSecrets(store, a);
  assert.deepEqual(first.generated, ["TOLLGATE_SECRET", "LICENSE_SIGNING_KEY", "RELAYER_PRIVATE_KEY"]);
  assert.match(a.TOLLGATE_SECRET!, /^[0-9a-f]{64}$/);
  assert.equal(createPrivateKey(a.LICENSE_SIGNING_KEY!).asymmetricKeyType, "ed25519");
  assert.match(a.RELAYER_PRIVATE_KEY!, /^0x[0-9a-f]{64}$/);

  const b: NodeJS.ProcessEnv = {};
  const second = await bootstrapSecrets(store, b);
  assert.deepEqual(second, { generated: [], restored: ["TOLLGATE_SECRET", "LICENSE_SIGNING_KEY", "RELAYER_PRIVATE_KEY"] });
  assert.deepEqual(b, a);
});

test("a secret in the environment wins and is never copied into the store", async () => {
  const store = memoryStateStore();
  const env: NodeJS.ProcessEnv = { TOLLGATE_SECRET: "from-env" };
  const r = await bootstrapSecrets(store, env);
  assert.equal(env.TOLLGATE_SECRET, "from-env");
  assert.equal(r.generated.includes("TOLLGATE_SECRET"), false);
  assert.equal(await store.get("secret:tollgate_secret"), null);
});

test("a gate settling on Base gets no relayer, and mainnet gas is never generated", async () => {
  const env: NodeJS.ProcessEnv = { SETTLEMENT_NETWORK: "base" };
  const r = await bootstrapSecrets(memoryStateStore(), env);
  assert.equal(env.RELAYER_PRIVATE_KEY, undefined);
  assert.equal(r.generated.includes("RELAYER_PRIVATE_KEY"), false);
  assert.equal(env.RELAYER_PRIVATE_KEY_MAINNET, undefined);
  const arc: NodeJS.ProcessEnv = { SETTLEMENT_NETWORK: "arc" };
  await bootstrapSecrets(memoryStateStore(), arc);
  assert.equal(arc.RELAYER_PRIVATE_KEY_MAINNET, undefined);
});

test("the boot log names what was generated and why, never the value", async () => {
  const env: NodeJS.ProcessEnv = {};
  const lines = describeBootstrap(await bootstrapSecrets(memoryStateStore(), env), "/data");
  assert.equal(lines.length, 3);
  for (const l of lines) for (const v of [env.TOLLGATE_SECRET!, env.RELAYER_PRIVATE_KEY!]) assert.equal(l.includes(v), false);
  assert.match(lines[0]!, /generated TOLLGATE_SECRET and stored it in \/data/);
});

test("a relayer key is always a valid secp256k1 scalar", () => {
  for (let i = 0; i < 200; i++) {
    const n = BigInt(secp256k1PrivateKey());
    assert.ok(n > 0n && n < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n);
  }
});
