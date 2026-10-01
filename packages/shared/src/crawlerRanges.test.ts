import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIp } from "./ipRange.ts";
import {
  applyFetch, compileRanges, emptySourceState, FRESH_MS, isFresh, parseLineList, parseRangeFile,
  parseRangesDocument, UNION_MS, unionOf, type CrawlerRangesDocument,
} from "./crawlerRanges.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

test("parseRangeFile: Google shape, mixed families, junk rejected", () => {
  const body = JSON.stringify({ creationTime: "x", prefixes: [{ ipv4Prefix: "66.249.64.0/27" }, { ipv6Prefix: "2001:4860:4801:10::/64" }, { ipv4Prefix: "0.0.0.0/0" }, { other: 1 }] });
  assert.deepEqual(parseRangeFile(body), ["66.249.64.0/27", "2001:4860:4801:10::/64"]);
  assert.equal(parseRangeFile("<!doctype html>"), null);
  assert.equal(parseRangeFile(JSON.stringify({ prefixes: [] })), null);
  assert.equal(parseRangeFile(JSON.stringify({ prefixes: [{ ipv4Prefix: "0.0.0.0/0" }] })), null);
});

test("parseLineList: one prefix per line", () => {
  assert.deepEqual(parseLineList("173.245.48.0/20\n103.21.244.0/22\n\n"), ["173.245.48.0/20", "103.21.244.0/22"]);
  assert.equal(parseLineList("<html>"), null);
});

test("applyFetch: good fetch records prefixes and health", () => {
  const s = applyFetch(emptySourceState("u", T0), { kind: "ok", prefixes: ["66.249.64.0/27"], finalUrl: "u" }, T0);
  assert.equal(s.lastGoodAt, T0);
  assert.equal(s.health.status, "ok");
  assert.deepEqual(unionOf(s, T0), ["66.249.64.0/27"]);
});

test("applyFetch: a redirect is good data with redirected health and the final URL", () => {
  const s = applyFetch(emptySourceState("old", T0), { kind: "ok", prefixes: ["66.249.64.0/27"], finalUrl: "new" }, T0);
  assert.equal(s.health.status, "redirected");
  assert.equal(s.health.finalUrl, "new");
  assert.equal(s.lastGoodAt, T0);
});

test("applyFetch: a file that shrinks by more than half is refused and the old data kept", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `66.249.${i}.0/24`);
  let s = applyFetch(emptySourceState("u", T0), { kind: "ok", prefixes: ten, finalUrl: "u" }, T0);
  s = applyFetch(s, { kind: "ok", prefixes: ten.slice(0, 4), finalUrl: "u" }, T0 + DAY);
  assert.equal(s.health.status, "shrunk");
  assert.equal(s.lastGoodAt, T0);
  assert.equal(unionOf(s, T0 + DAY).length, 10);
});

test("unionOf: a prefix stays 30 days after it was last seen, then drops", () => {
  let s = applyFetch(emptySourceState("u", T0), { kind: "ok", prefixes: ["66.249.1.0/24", "66.249.2.0/24"], finalUrl: "u" }, T0);
  s = applyFetch(s, { kind: "ok", prefixes: ["66.249.2.0/24"], finalUrl: "u" }, T0 + DAY);
  assert.equal(unionOf(s, T0 + DAY).length, 2);
  assert.ok(!unionOf(s, T0 + UNION_MS + 1).includes("66.249.1.0/24"));
  assert.ok(unionOf(s, T0 + UNION_MS + 1).includes("66.249.2.0/24"));
});

test("applyFetch: failures keep data, set health, keep the original since", () => {
  let s = applyFetch(emptySourceState("u", T0), { kind: "ok", prefixes: ["66.249.1.0/24"], finalUrl: "u" }, T0);
  s = applyFetch(s, { kind: "http-error", status: 404 }, T0 + DAY);
  s = applyFetch(s, { kind: "http-error", status: 404 }, T0 + 2 * DAY);
  assert.equal(s.health.status, "http-error");
  assert.equal(s.health.since, T0 + DAY);
  assert.equal(s.lastGoodAt, T0);
});

const doc = (fetchedAt: string | null): CrawlerRangesDocument => ({
  version: 1, generatedAt: new Date(T0).toISOString(),
  proxies: { cloudflare: ["173.245.48.0/20"] },
  operators: [{ id: "google", operator: "Google", fragments: ["googlebot"], kind: "ranges", forgedEligible: true, fetchedAt, prefixes: ["66.249.64.0/27"] }],
  sources: [],
});

test("compileRanges + isFresh", () => {
  const c = compileRanges(doc(new Date(T0).toISOString()));
  const g = c.operators.get("google")!;
  assert.equal(g.set.has(parseIp("66.249.64.3")!), true);
  assert.equal(isFresh(g, T0 + FRESH_MS), true);
  assert.equal(isFresh(g, T0 + FRESH_MS + 1), false);
  assert.equal(isFresh(compileRanges(doc(null)).operators.get("google")!, T0), false);
  assert.equal(c.proxies.get("cloudflare")!.has(parseIp("173.245.48.9")!), true);
});

test("parseRangesDocument rejects wrong shapes", () => {
  assert.ok(parseRangesDocument(JSON.parse(JSON.stringify(doc(null)))));
  assert.equal(parseRangesDocument({ version: 2 }), null);
  assert.equal(parseRangesDocument({ version: 1, operators: "x" }), null);
  assert.equal(parseRangesDocument(null), null);
});

test("an empty proxy list or an empty fragment refuses the document", () => {
  const good = JSON.parse(JSON.stringify(doc(null))) as CrawlerRangesDocument;
  assert.ok(parseRangesDocument({ ...good, proxies: { cloudflare: ["173.245.48.0/20"] } }));
  // A proxy list nobody fetched reads as "no proxy", and that proxy's own address as a caller's.
  assert.equal(parseRangesDocument({ ...good, proxies: { cloudflare: [] } }), null);
  // An empty fragment is a substring of every user-agent.
  assert.equal(parseRangesDocument({ ...good, operators: [{ ...good.operators[0]!, fragments: [""] }] }), null);
});

test("I4: a smaller copy served identically three fetches running is a real change, not a broken file", () => {
  const url = "https://op.example/r.json";
  const big = Array.from({ length: 20 }, (_, i) => `66.${i}.0.0/16`);
  const merged = ["66.0.0.0/12", "66.16.0.0/14"];
  let s = applyFetch(emptySourceState(url, T0), { kind: "ok", prefixes: big, finalUrl: url }, T0);
  s = applyFetch(s, { kind: "ok", prefixes: merged, finalUrl: url }, T0 + DAY);
  assert.equal(s.health.status, "shrunk");
  assert.equal(s.lastGoodCount, 20);
  s = applyFetch(s, { kind: "ok", prefixes: merged, finalUrl: url }, T0 + 2 * DAY);
  assert.equal(s.health.status, "shrunk");
  s = applyFetch(s, { kind: "ok", prefixes: [...merged].reverse(), finalUrl: url }, T0 + 3 * DAY);
  assert.equal(s.health.status, "ok");
  assert.equal(s.lastGoodCount, 2);
  assert.equal(s.lastGoodAt, T0 + 3 * DAY);
});

test("I4: a different small copy each time never gets past the shrink guard", () => {
  const url = "https://op.example/r.json";
  const big = Array.from({ length: 20 }, (_, i) => `66.${i}.0.0/16`);
  let s = applyFetch(emptySourceState(url, T0), { kind: "ok", prefixes: big, finalUrl: url }, T0);
  for (let i = 1; i <= 5; i++) s = applyFetch(s, { kind: "ok", prefixes: [`67.${i}.0.0/16`], finalUrl: url }, T0 + i * DAY);
  assert.equal(s.health.status, "shrunk");
  assert.equal(s.lastGoodCount, 20);
});
