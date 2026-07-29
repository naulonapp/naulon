import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc, type ObservationEvent, type ObservationVerdict } from "@naulon/shared";
import {
  agentKeyOf,
  buildAgents,
  buildTraffic,
  filterObservations,
  identityOf,
  missedByCause,
  parseVerdict,
  rollupAgents,
  rollupPaths,
} from "./traffic.ts";

const NOW = 1_800_000_000_000;
let seq = 0;

function obs(o: Partial<ObservationEvent> & { verdict: ObservationVerdict }): ObservationEvent {
  return {
    id: `o${++seq}`,
    host: "example.test",
    slug: "on-stillness",
    classifiedAs: "agent",
    at: NOW,
    ...o,
  };
}

test("parseVerdict narrows to the known six and rejects anything else", () => {
  assert.equal(parseVerdict("paid"), "paid");
  assert.equal(parseVerdict("payment-failed"), "payment-failed");
  // An unknown value must fall back to "all", never match nothing — a filter that
  // silently returns an empty page reads as "no traffic", which is a different claim.
  assert.equal(parseVerdict("PAID"), undefined);
  assert.equal(parseVerdict("nonsense"), undefined);
  assert.equal(parseVerdict(undefined), undefined);
});

test("identity puts a failed signature under masquerade, never unsigned", () => {
  assert.equal(identityOf(obs({ verdict: "paid", verified: true })), "verified");
  assert.equal(identityOf(obs({ verdict: "denied" })), "unsigned");
  assert.equal(identityOf(obs({ verdict: "denied", sigInvalid: true })), "masquerade");
  // verified wins even if both flags somehow appear — a verified signature is proof.
  assert.equal(identityOf(obs({ verdict: "paid", verified: true, sigInvalid: true })), "verified");
});

test("a verified agent groups by its directory host, not its drifting UA", () => {
  const a = obs({ verdict: "paid", verified: true, verifiedAgent: "chatgpt.com", agentUa: "GPTBot/1.0" });
  const b = obs({ verdict: "paid", verified: true, verifiedAgent: "chatgpt.com", agentUa: "GPTBot/1.2" });
  assert.equal(agentKeyOf(a), "chatgpt.com");
  assert.equal(agentKeyOf(b), "chatgpt.com");
  assert.equal(rollupAgents([a, b]).length, 1, "one operator, one row");
});

test("an agent with no user-agent at all still gets a stable key", () => {
  assert.equal(agentKeyOf(obs({ verdict: "denied" })), "(no user-agent)");
});

test("the window filter excludes anything older than `since`", () => {
  const rows = [obs({ verdict: "paid", at: NOW }), obs({ verdict: "paid", at: NOW - 10_000 })];
  assert.equal(filterObservations(rows, { since: NOW - 5_000 }).length, 1);
});

test("the text filter searches slug, host, UA, verified agent and classify reason", () => {
  const rows = [
    obs({ verdict: "paid", slug: "on-stillness" }),
    obs({ verdict: "paid", slug: "other", host: "blog.test" }),
    obs({ verdict: "paid", slug: "third", agentUa: "ClaudeBot/1.0" }),
    obs({ verdict: "paid", slug: "fourth", verifiedAgent: "chatgpt.com" }),
    obs({ verdict: "denied", slug: "fifth", classifyReason: "ua-pattern:bot" }),
  ];
  const q = (needle: string) => filterObservations(rows, { since: 0, q: needle }).length;
  assert.equal(q("stillness"), 1);
  assert.equal(q("blog.test"), 1);
  assert.equal(q("claudebot"), 1, "case-insensitive");
  assert.equal(q("chatgpt"), 1);
  assert.equal(q("ua-pattern"), 1);
  assert.equal(q("nothing-here"), 0);
});

test("paths split earned from missed, and never add a denial to earnings", () => {
  const rows = [
    obs({ verdict: "paid", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "paid", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "denied", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "payment-failed", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "served-free", slug: "a" }),
  ];
  const [a] = rollupPaths(rows);
  assert.equal(a!.requests, 5);
  assert.equal(a!.paid, 2);
  assert.equal(a!.earned, 0.02);
  assert.equal(a!.missed, 0.02, "denied + payment-failed, never folded into earned");
  assert.equal(a!.servedFree, 1);
});

test("a non-article gated path is labelled rather than rolled up under an empty slug", () => {
  const [row] = rollupPaths([obs({ verdict: "denied", slug: "", price: usdc(0.01) })]);
  assert.equal(row!.slug, "(non-article)");
});

test("paths sort by money earned, then by money missed, then by volume", () => {
  const rows = [
    obs({ verdict: "served-free", slug: "busy" }),
    obs({ verdict: "served-free", slug: "busy" }),
    obs({ verdict: "denied", slug: "wanted", price: usdc(0.05) }),
    obs({ verdict: "paid", slug: "earner", price: usdc(0.01) }),
  ];
  assert.deepEqual(
    rollupPaths(rows).map((r) => r.slug),
    ["earner", "wanted", "busy"],
  );
});

test("humans never appear in the agent rollup — they read free by design", () => {
  const rows = [
    obs({ verdict: "served-free", classifiedAs: "human" }),
    obs({ verdict: "denied", agentUa: "SomeBot" }),
  ];
  const agents = rollupAgents(rows);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.agent, "SomeBot");
});

test("one failed signature marks the whole agent a masquerade", () => {
  const rows = [
    obs({ verdict: "denied", agentUa: "SomeBot" }),
    obs({ verdict: "denied", agentUa: "SomeBot", sigInvalid: true }),
    obs({ verdict: "denied", agentUa: "SomeBot" }),
  ];
  assert.equal(rollupAgents(rows)[0]!.identity, "masquerade");
});

test("a verified request outranks a masquerade on the same key", () => {
  const rows = [
    obs({ verdict: "denied", agentUa: "SomeBot", sigInvalid: true }),
    obs({ verdict: "paid", agentUa: "SomeBot", verified: true, price: usdc(0.01) }),
  ];
  // Same key only because the verified row has no verifiedAgent to group under.
  assert.equal(rollupAgents(rows)[0]!.identity, "verified");
});

test("agent rows count free reads separately from paid and refused", () => {
  const rows = [
    obs({ verdict: "served-free", agentUa: "B" }),
    obs({ verdict: "agent-reread", agentUa: "B" }),
    obs({ verdict: "paid", agentUa: "B", price: usdc(0.01) }),
    obs({ verdict: "denied", agentUa: "B", price: usdc(0.01) }),
    obs({ verdict: "blocked", agentUa: "B" }),
    obs({ verdict: "payment-failed", agentUa: "B", price: usdc(0.02) }),
  ];
  const [b] = rollupAgents(rows);
  assert.equal(b!.free, 2, "served-free + agent-reread");
  assert.equal(b!.paid, 1);
  assert.equal(b!.denied, 1);
  assert.equal(b!.blocked, 1);
  assert.equal(b!.paymentFailed, 1);
  assert.equal(b!.earned, 0.01);
  assert.equal(b!.missed, 0.03);
});

test("missed earnings keep the two causes apart — they are different problems", () => {
  const rows = [
    obs({ verdict: "denied", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "denied", slug: "a", price: usdc(0.01) }),
    obs({ verdict: "payment-failed", slug: "a", price: usdc(0.05) }),
    obs({ verdict: "paid", slug: "a", price: usdc(0.01) }),
  ];
  const m = missedByCause(rows);
  assert.deepEqual(m.denied, { requests: 2, usdc: 0.02 });
  assert.deepEqual(m.paymentFailed, { requests: 1, usdc: 0.05 });
  assert.equal(m.byPath.length, 1);
  assert.equal(m.byPath[0]!.deniedUsdc, 0.02);
  assert.equal(m.byPath[0]!.paymentFailedUsdc, 0.05);
});

test("a path that missed nothing is absent from the by-cause breakdown", () => {
  assert.equal(missedByCause([obs({ verdict: "paid", price: usdc(0.01) })]).byPath.length, 0);
});

test("buildTraffic reports `matched` above the row cap, so a capped list cannot read as the whole truth", () => {
  const rows = Array.from({ length: 25 }, (_, i) => obs({ verdict: "denied", at: NOW - i, price: usdc(0.001) }));
  const report = buildTraffic(rows, { since: 0 }, NOW, { rowLimit: 10 });
  assert.equal(report.rows.length, 10);
  assert.equal(report.matched, 25);
  assert.equal(report.rows[0]!.at, NOW, "newest first");
});

test("buildTraffic's verdict counts are of the FILTERED set, not the whole log", () => {
  const rows = [
    obs({ verdict: "paid", price: usdc(0.01) }),
    obs({ verdict: "denied", price: usdc(0.01) }),
    obs({ verdict: "denied", price: usdc(0.01) }),
  ];
  const report = buildTraffic(rows, { since: 0, verdict: "denied" }, NOW);
  assert.equal(report.byVerdict.denied, 2);
  assert.equal(report.byVerdict.paid, 0, "a filtered-out verdict reads zero, matching what is on screen");
});

test("buildTraffic zeroes every verdict, so a missing key never renders as undefined", () => {
  const report = buildTraffic([], { since: 0 }, NOW);
  for (const v of ["served-free", "agent-reread", "denied", "blocked", "payment-failed", "paid"] as const) {
    assert.equal(report.byVerdict[v], 0);
  }
});

test("buildAgents splits identity and counts only agent traffic", () => {
  const rows = [
    obs({ verdict: "served-free", classifiedAs: "human" }),
    obs({ verdict: "paid", verified: true, verifiedAgent: "chatgpt.com", price: usdc(0.01) }),
    obs({ verdict: "denied", agentUa: "Plain", price: usdc(0.01) }),
    obs({ verdict: "denied", agentUa: "Liar", sigInvalid: true, price: usdc(0.01) }),
  ];
  const r = buildAgents(rows, { since: 0 }, NOW);
  assert.deepEqual(r.split, { total: 3, verified: 1, unsigned: 1, masquerade: 1 });
  assert.equal(r.agents.length, 3, "the human is not an agent row");
});
