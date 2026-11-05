import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileConnectStore } from "./local.ts";

const pending = (expiresAt: number) => ({ site: "https://blog.example.com", gate: "https://gate.example.com", verifier: "v", challenge: "c", redirectUri: "https://blog.example.com/naulon/connect/return", expiresAt });
const STATE = "s".repeat(32);

test("of many takes racing for one connect, exactly one gets it", async () => {
  const store = fileConnectStore(mkdtempSync(join(tmpdir(), "naulon-local-")));
  await store.put(STATE, pending(Date.now() + 60_000));
  const got = (await Promise.all(Array.from({ length: 20 }, () => store.take(STATE)))).filter(Boolean);
  assert.equal(got.length, 1);
  assert.equal(await store.get(STATE), null, "and it is gone");
});

test("an expired connect is not handed out", async () => {
  let t = 1_000;
  const store = fileConnectStore(mkdtempSync(join(tmpdir(), "naulon-local-")), () => t);
  await store.put(STATE, pending(2_000));
  t = 2_000;
  assert.equal(await store.get(STATE), null);
  assert.equal(await store.take(STATE), null);
});

test("everything it writes is the owner's alone, and a state cannot name a path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naulon-local-"));
  const store = fileConnectStore(dir);
  await store.put(STATE, pending(Date.now() + 60_000));
  await store.putResult(STATE, { ok: true, site: "https://blog.example.com", gate: "https://gate.example.com" });
  store.writeCredential(`nln_site_${"A".repeat(43)}`);
  assert.equal(statSync(join(dir, "connect")).mode & 0o777, 0o700);
  for (const f of readdirSync(join(dir, "connect"))) assert.equal(statSync(join(dir, "connect", f)).mode & 0o777, 0o600, f);
  assert.equal(statSync(join(dir, "credential")).mode & 0o777, 0o600);
  assert.equal(await store.get("../../etc/passwd"), null);
  await assert.rejects(store.put("../escape-this-dir-please", pending(1)));
  assert.equal(store.readCredential(), `nln_site_${"A".repeat(43)}`);
  assert.deepEqual(await store.takeResult(STATE), { ok: true, site: "https://blog.example.com", gate: "https://gate.example.com" });
  assert.equal(await store.takeResult(STATE), null, "a result is read once");
});

test("a credential file holding anything but a site credential is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naulon-local-"));
  const store = fileConnectStore(dir);
  store.writeCredential("not-a-credential");
  assert.equal(store.readCredential(), null);
});
