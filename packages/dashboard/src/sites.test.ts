import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { issueCredential, listCredentials, memoryStateStore, resolveCredential, seenRecorder } from "@naulon/shared";
import { buildSitesView, revokeConnection } from "./sites.ts";
import { audited, setAuditDetail } from "./console-auth.ts";
import { memoryAuditor } from "./console-audit.ts";

const grant = (site: string, clientName = "WordPress") => ({ site, clientId: `${site}/.well-known/naulon-client`, clientName, approvedBy: "alice" });

test("connections are grouped by site, sites by host, the newest connection first", async () => {
  const state = memoryStateStore();
  await issueCredential(state, grant("https://zine.example.org"), 1);
  const older = await issueCredential(state, grant("https://blog.example.com"), 2);
  const newer = await issueCredential(state, grant("https://blog.example.com", "WordPress, reconnected"), 3);
  seenRecorder(state, { now: () => 50 })(older);
  await new Promise((r) => setImmediate(r));

  const v = await buildSitesView(state, { legacyKey: false });
  assert.deepEqual(v.sites.map((s) => s.host), ["blog.example.com", "zine.example.org"]);
  assert.deepEqual(v.sites[0]!.connections.map((c) => c.clientName), ["WordPress, reconnected", "WordPress"]);
  assert.equal(v.sites[0]!.connections[1]!.lastSeenAt, 50);
  assert.equal(v.sites[0]!.connections[0]!.lastSeenAt, null);
  assert.equal(v.sites[0]!.connections[0]!.hint, newer.slice(-4));
  assert.equal(JSON.stringify(v).includes(newer), false, "the view never carries a credential");
  assert.equal((await buildSitesView(state, { legacyKey: true })).legacyKey, true);
});

test("revoke takes an id, names what it removed, and the credential stops resolving", async () => {
  const state = memoryStateStore();
  const cred = await issueCredential(state, grant("https://blog.example.com"));
  const [held] = await listCredentials(state);
  assert.deepEqual(await revokeConnection(state, held!.id), { ok: true, site: "https://blog.example.com", clientName: "WordPress" });
  assert.equal(await resolveCredential(state, cred), null);
  assert.equal((await revokeConnection(state, held!.id)).ok, false, "a second revoke finds nothing");
});

test("revoke refuses anything that is not an id, including the credential itself", async () => {
  const state = memoryStateStore();
  const cred = await issueCredential(state, grant("https://blog.example.com"));
  for (const bad of [cred, "../credential:x", 42, undefined, "A".repeat(64)]) {
    assert.equal((await revokeConnection(state, bad)).ok, false, String(bad));
  }
  assert.notEqual(await resolveCredential(state, cred), null);
});

test("an audited write can name what it acted on", async () => {
  const auditor = memoryAuditor();
  const app = new Hono();
  app.post("/x", audited("console.site_revoke", auditor), (c) => {
    setAuditDetail(c, { site: "https://blog.example.com" });
    return c.text("ok");
  });
  app.post("/y", audited("console.other", auditor), (c) => c.text("ok"));
  await app.request("/x", { method: "POST" });
  await app.request("/y", { method: "POST" });
  assert.deepEqual(auditor.entries.map((e) => e.detail), [{ site: "https://blog.example.com", status: 200 }, { status: 200 }]);
});
