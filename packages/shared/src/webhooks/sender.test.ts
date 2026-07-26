import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import {
  isBlockedTarget,
  isAllowedChatHost,
  guardTarget,
  guardedLookup,
  HttpWebhookSender,
  NoopWebhookSender,
} from "./sender.ts";
import type { CanonicalEvent } from "./transform.ts";

test("isBlockedTarget blocks loopback/private/link-local + metadata IP", () => {
  for (const ip of ["127.0.0.1", "::1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "169.254.0.1"]) {
    assert.equal(isBlockedTarget(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedTarget allows public IPs", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert.equal(isBlockedTarget(ip), false, `${ip} should be allowed`);
  }
});

test("isAllowedChatHost: exact + suffix match per channel", () => {
  assert.equal(isAllowedChatHost("slack", "hooks.slack.com"), true);
  assert.equal(isAllowedChatHost("slack", "evil.com"), false);
  assert.equal(isAllowedChatHost("discord", "discord.com"), true);
  assert.equal(isAllowedChatHost("teams", "prod-1.westeurope.logic.azure.com"), true);
  assert.equal(isAllowedChatHost("teams", "logic.azure.com.evil.com"), false); // suffix, not includes
});

test("guardTarget: raw rejects http; chat rejects non-allowlisted host", async () => {
  assert.equal((await guardTarget("raw", "http://x.test", false)).ok, false);
  assert.equal((await guardTarget("slack", "https://evil.com/x", false)).ok, false);
  assert.equal((await guardTarget("slack", "https://hooks.slack.com/x", false)).ok, true);
});

test("guardTarget: raw blocks a private literal unless allowPrivate", async () => {
  assert.equal((await guardTarget("raw", "https://127.0.0.1/h", false)).ok, false);
  assert.equal((await guardTarget("raw", "https://127.0.0.1/h", true)).ok, true);
});

const CANON: CanonicalEvent = { id: "d1", type: "anomaly.detected", eventId: "e1", createdAt: 0, data: { detail: "x" } };

test("HttpWebhookSender returns blocked (non-retryable) for a guarded target", async () => {
  const sender = new HttpWebhookSender({ timeoutMs: 1000, allowPrivateTargets: false });
  const r = await sender.send("raw", "anomaly.detected", "http://x.test", "whsec", "d1", CANON, 0);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
});

test("HttpWebhookSender signs raw + treats 2xx as success", async () => {
  let sawSig = "";
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sawSig = ((init?.headers ?? {}) as Record<string, string>)["Naulon-Signature"] ?? "";
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const sender = new HttpWebhookSender({ timeoutMs: 1000, allowPrivateTargets: false, fetchImpl });
  const r = await sender.send("raw", "anomaly.detected", "https://8.8.8.8/h", "whsec", "d1", CANON, 1_700_000_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 200);
  assert.match(sawSig, /^t=\d+,v1=[0-9a-f]{64}$/);
});

test("HttpWebhookSender parses Retry-After on 429", async () => {
  const fetchImpl = (async () =>
    new Response("slow down", { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
  const sender = new HttpWebhookSender({ timeoutMs: 1000, allowPrivateTargets: false, fetchImpl });
  const r = await sender.send("slack", "anomaly.detected", "https://hooks.slack.com/x", "", "d1", CANON, 0);
  assert.equal(r.ok, false);
  assert.equal(r.statusCode, 429);
  assert.equal(r.retryAfterMs, 120_000);
});

test("guardedLookup blocks a host that resolves to a private IP at connect time (anti-rebind)", async () => {
  // localhost deterministically resolves to a loopback IP → the connect-time lookup must reject it,
  // closing the TOCTOU window a plain re-resolving fetch would leave open.
  const blockLookup = promisify(guardedLookup(false));
  await assert.rejects(() => blockLookup("localhost", {}), /blocked target \(private\/loopback\)/);
  // allowPrivate (the raw-only dev knob) lets it through.
  const allowLookup = promisify(guardedLookup(true));
  const addr = (await allowLookup("localhost", {})) as unknown as string;
  assert.ok(typeof addr === "string" && addr.length > 0);
});

test("NoopWebhookSender never sends", async () => {
  const r = await new NoopWebhookSender().send("raw", "anomaly.detected", "https://8.8.8.8/h", "s", "d", CANON, 0);
  assert.equal(r.ok, false);
});
