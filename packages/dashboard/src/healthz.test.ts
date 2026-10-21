import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A console with an account, the shape every container runs in.
process.env.CONSOLE_STATE_PATH = join(mkdtempSync(join(tmpdir(), "naulon-healthz-")), "console.json");
process.env.CONSOLE_ADMIN_PASSWORD = "Healthz-Test-Password-1";
const { app } = await import("./server.ts");
const local = { headers: { Host: "127.0.0.1:8403" } };

test("the health check answers without a sign-in", async () => {
  const res = await app.request("/healthz", local);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "dashboard" });
});

test("and nothing else does", async () => {
  assert.equal((await app.request("/api/ops", local)).status, 401);
});
