import { test } from "node:test";
import assert from "node:assert/strict";
import { httpCrawlerRangesSource } from "./rangesSource.ts";

const DOC = {
  version: 1, generatedAt: "2026-10-01T00:00:00Z", proxies: {}, sources: [],
  operators: [{ id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges", forgedEligible: true, fetchedAt: "2026-10-01T00:00:00Z", prefixes: ["66.249.64.0/27"] }],
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test("null until the first fetch lands, then cached for ttlMs, single-flight", async () => {
  let calls = 0;
  let t = 0;
  const src = httpCrawlerRangesSource("https://gate.test/.well-known/naulon/crawler-ranges.json", {
    now: () => t,
    ttlMs: 1000,
    fetchImpl: (async () => { calls++; return new Response(JSON.stringify(DOC)); }) as typeof fetch,
  });
  assert.equal(src.current(), null);
  assert.equal(src.current(), null);
  await tick();
  assert.equal(calls, 1);
  assert.ok(src.current()?.operators.get("google"));
  t = 1001;
  src.current();
  await tick();
  assert.equal(calls, 2);
});

test("a failed fetch keeps what it had and waits retryMs before trying again", async () => {
  let t = 0;
  let calls = 0;
  let mode: "good" | "bad" = "good";
  const src = httpCrawlerRangesSource("https://gate.test/x", {
    now: () => t,
    ttlMs: 10,
    retryMs: 100,
    fetchImpl: (async () => { calls++; return mode === "good" ? new Response(JSON.stringify(DOC)) : new Response("{}", { status: 500 }); }) as typeof fetch,
  });
  src.current();
  await tick();
  mode = "bad";
  t = 20;
  src.current();
  await tick();
  assert.ok(src.current()?.operators.get("google"));
  const after = calls;
  t = 50;
  src.current();
  await tick();
  assert.equal(calls, after);
  t = 121;
  src.current();
  await tick();
  assert.equal(calls, after + 1);
});
