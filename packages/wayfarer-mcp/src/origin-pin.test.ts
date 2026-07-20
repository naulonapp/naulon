/**
 * CHARACTERIZATION of the BUY-1.3 origin pin (`originPinRefusal`, server.ts).
 *
 * The pin is a SECURITY control — it exists so a prompt-injected model cannot aim
 * quote/pay at an attacker origin whose 402 names the attacker's own payTo
 * (server.ts:113-118) — and it shipped with NO test coverage. These tests pin the
 * CURRENT behavior byte-for-byte so the upcoming unification refactor is provably
 * behavior-preserving where it should be, and provably changed where it should be.
 *
 * Read this file as "what the pin does today", not "what it ought to do". In
 * particular `allowDomains is ignored by the MCP pin` documents a DRIFT from
 * decide.ts:250 (the run()/research counterpart, which honors allowDomains) and is
 * expected to be inverted when the shared origin policy lands.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetConfig } from "@naulon/shared";
import { DEFAULT_POLICY } from "@naulon/wayfarer";

import { buildServer, type BuildServerOptions } from "./server.ts";

/** Stand up an isolated server + connected client over a linked in-memory pair. */
async function connectedClientWith(opts?: BuildServerOptions): Promise<Client> {
  const server = buildServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "origin-pin-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Run `fn` with env overrides applied (undefined = unset), restoring after. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  resetConfig();
  try {
    return await fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    resetConfig();
  }
}

/** The configured gate for these tests. Nothing listens on it — every assertion below
 *  is about the pin's REFUSAL, which happens before any socket is opened. */
const GATE = "https://gate.example";

type QuoteResult = { gated: boolean; note?: string };
type PayResult = { ok: boolean; error?: string; spentSessionUsdc: number };

async function quoteUrl(url: string, opts?: BuildServerOptions): Promise<QuoteResult> {
  const client = await connectedClientWith({ tollgateUrl: GATE, ...opts });
  const res = await client.callTool({ name: "naulon_quote", arguments: { slug: "x", url } });
  return res.structuredContent as QuoteResult;
}

async function payUrl(url: string, opts?: BuildServerOptions): Promise<PayResult> {
  const client = await connectedClientWith({ tollgateUrl: GATE, ...opts });
  const res = await client.callTool({ name: "naulon_pay_and_read", arguments: { slug: "x", url } });
  return res.structuredContent as PayResult;
}

test("quote refuses an off-gate url before touching the network", async () => {
  const q = await quoteUrl("https://evil.example/essays/x");
  assert.match(q.note ?? "", /refusing to touch evil\.example/);
  assert.match(q.note ?? "", /only quotes and pays at its configured gate \(gate\.example\)/);
  assert.equal(q.gated, false, "a refusal is not reported as a gated read");
});

test("pay refuses an off-gate url and spends nothing", async () => {
  const r = await payUrl("https://evil.example/essays/x");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /refusing to touch evil\.example/);
  assert.equal(r.spentSessionUsdc, 0, "a refused pay must not move money");
});

test("the pin is endpoint identity: a different PORT on the same hostname is refused", async () => {
  const q = await quoteUrl("https://gate.example:8443/essays/x");
  assert.match(
    q.note ?? "",
    /refusing to touch gate\.example:8443/,
    "hostOf() includes the port — a different port is a different service",
  );
});

test("the pin is host-case-insensitive: an uppercased gate host is accepted", async () => {
  const q = await quoteUrl("https://GATE.EXAMPLE/essays/x");
  assert.doesNotMatch(
    q.note ?? "",
    /refusing to touch/,
    "URL hosts are case-insensitive; the pin lowercases both sides",
  );
});

test("a subdomain of the gate is NOT implied by the gate — it is refused", async () => {
  const q = await quoteUrl("https://sub.gate.example/essays/x");
  assert.match(q.note ?? "", /refusing to touch sub\.gate\.example/);
});

test("a malformed url is rejected as invalid, not as off-gate", async () => {
  const q = await quoteUrl("not-a-url");
  assert.match(q.note ?? "", /"not-a-url" is not a valid URL\./);
});

test("an unparseable configured gate names TOLLGATE_URL as the thing to fix", async () => {
  const q = await quoteUrl("https://gate.example/essays/x", { tollgateUrl: "://broken" });
  assert.match(q.note ?? "", /is not a valid URL — fix TOLLGATE_URL/);
});

test("an explicitly allowed domain is payable off-gate — the allowlist REPLACES the pin", async () => {
  // Was the DRIFT characterization: the MCP pin used unconditional host:port equality and
  // ignored policy.allowDomains, so a directory-supplied publisher URL (inneraxiom.com) was
  // unpayable over the hosted MCP no matter how the gate was configured. `authorizeOrigin`
  // now defers to spendGate when the operator has stated a domain boundary, matching
  // decide.ts. This expectation is the inversion that unification was for.
  const q = await quoteUrl("https://allowed.example/articles/x", {
    policy: { ...DEFAULT_POLICY, allowDomains: ["allowed.example"] },
  });
  assert.doesNotMatch(
    q.note ?? "",
    /refusing to touch/,
    "a stated allowlist replaces endpoint identity; spendGate adjudicates the domain",
  );
});

test("a domain OUTSIDE a stated allowlist is still refused, by policy rather than by identity", async () => {
  // The allowlist replacing the pin must not mean "anything goes once an allowlist exists".
  // Identity steps aside, spendGate takes over — and it denies a host it never named.
  const q = await quoteUrl("https://evil.example/articles/x", {
    policy: { ...DEFAULT_POLICY, allowDomains: ["allowed.example"] },
  });
  assert.match(q.note ?? "", /not in allowlist/);
  assert.equal(q.gated, false);
});

test("an EMPTY allowlist denies everything and never probes — deny-by-default, not allow-all", async () => {
  // The sharp edge of "a stated allowlist replaces the pin": an empty array is STATED, so
  // identity defers — and on the quote path there was no spendGate to defer TO. Without one,
  // `allowDomains: []` would turn the free probe into an open SSRF surface, which is the exact
  // hole the origin pin exists to close. Quote must consult spendGate, not just the pin.
  const q = await quoteUrl("https://evil.example/articles/x", {
    policy: { ...DEFAULT_POLICY, allowDomains: [] },
  });
  assert.match(q.note ?? "", /not in allowlist/);
  assert.doesNotMatch(q.note ?? "", /Probed /, "a policy refusal must happen BEFORE any socket is opened");
});

test("the kill switch stops the free probe too, not only the pay", async () => {
  // Same root cause as the empty-allowlist case: quote reaching the network while spend is
  // halted is a request the operator has said not to make.
  const q = await quoteUrl("https://gate.example/essays/x", {
    policy: { ...DEFAULT_POLICY, killSwitch: true },
  });
  assert.match(q.note ?? "", /kill-switch engaged/);
  assert.doesNotMatch(q.note ?? "", /Probed /);
});

test("omitting url falls back to the configured gate and is never self-refused", async () => {
  await withEnv({ TOLLGATE_URL: undefined }, async () => {
    const client = await connectedClientWith({ tollgateUrl: GATE });
    const res = await client.callTool({ name: "naulon_quote", arguments: { slug: "x" } });
    const q = res.structuredContent as QuoteResult;
    assert.doesNotMatch(
      q.note ?? "",
      /refusing to touch/,
      "the slug-template target is built FROM the gate, so it must always satisfy the pin",
    );
  });
});
