import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PATTERN_LEN,
  MAX_PRICE_RULES,
  normalizePathPatterns,
  normalizePriceRules,
  resolvePriceRule,
} from "./price-rules.ts";

/* ── the ordering contract ─────────────────────────────────────────────────── */

test("normalize sorts most-specific-first, so the stored order IS the resolution order", () => {
  const rules = normalizePriceRules([
    { pattern: "/", priceUsdc: 0.01 },
    { pattern: "/papers/*", priceUsdc: 0.05 },
    { pattern: "/papers/preview$", priceUsdc: 0.001 },
  ]);
  assert.deepEqual(
    rules.map((r) => r.pattern),
    ["/papers/preview$", "/papers/*", "/"],
  );
});

test("an anchored pattern outranks the same prefix unanchored", () => {
  const rules = normalizePriceRules([
    { pattern: "/a.pdf", priceUsdc: 0.02 },
    { pattern: "/a.pdf$", priceUsdc: 0.09 },
  ]);
  assert.equal(rules[0]?.pattern, "/a.pdf$");
});

test("equal-specificity rules keep the order they were authored in", () => {
  // Both are three literal characters, so nothing but the sort's stability separates them —
  // and `resolvePriceRule` returns the FIRST match, so this order is a money decision.
  const rules = normalizePriceRules([
    { pattern: "/x/*", priceUsdc: 0.02 },
    { pattern: "/*/x", priceUsdc: 0.09 },
  ]);
  assert.deepEqual(rules.map((r) => r.pattern), ["/x/*", "/*/x"]);
  assert.equal(resolvePriceRule(rules, "/x/x")?.priceUsdc, 0.02);
});

test("normalize does not mutate its input", () => {
  const input = [
    { pattern: "/", priceUsdc: 0.01 },
    { pattern: "/deep/section/*", priceUsdc: 0.05 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  normalizePriceRules(input);
  assert.deepEqual(input, snapshot);
});

/* ── what the write path refuses, and why each refusal earns its place ─────── */

test("the same pattern twice is refused — two prices for one path have no resolution order", () => {
  assert.throws(
    () => normalizePriceRules([{ pattern: "/a", priceUsdc: 1 }, { pattern: "/a", priceUsdc: 2 }]),
    /listed twice/,
  );
  // Whitespace-trimmed duplicates collide too, or the refusal is trivially bypassed.
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: 1 }, { pattern: " /a ", priceUsdc: 2 }]), /listed twice/);
});

test("overlapping patterns are NOT refused — they are the point", () => {
  // The spec proposed refusing these. "Everything under /papers costs more, except the preview"
  // is two overlapping rules and one intent; refusing it would remove the feature's main use.
  const rules = normalizePriceRules([
    { pattern: "/papers/*", priceUsdc: 0.05 },
    { pattern: "/papers/preview$", priceUsdc: 0.001 },
  ]);
  assert.equal(resolvePriceRule(rules, "/papers/deep/one")?.priceUsdc, 0.05);
  assert.equal(resolvePriceRule(rules, "/papers/preview")?.priceUsdc, 0.001);
});

test("a pattern with no leading slash is refused", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "papers/*", priceUsdc: 1 }]), /must start with/);
});

test("an empty or non-string pattern is refused", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "   ", priceUsdc: 1 }]), /empty pattern/);
  assert.throws(() => normalizePriceRules([{ priceUsdc: 1 }]), /no pattern/);
  assert.throws(() => normalizePriceRules([{ pattern: 7, priceUsdc: 1 }]), /no pattern/);
});

test("a non-object entry is refused rather than silently skipped", () => {
  assert.throws(() => normalizePriceRules(["/a"]), /not an object/);
  assert.throws(() => normalizePriceRules([null]), /not an object/);
  assert.throws(() => normalizePriceRules([["/a"]]), /not an object/);
});

test("a pattern carrying anything but printable ASCII is refused", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "/a b", priceUsdc: 1 }]), /printable ASCII/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a\tb", priceUsdc: 1 }]), /printable ASCII/);
  // The encoded form is the correct spelling and is accepted.
  assert.equal(normalizePriceRules([{ pattern: "/a%20b", priceUsdc: 1 }])[0]?.pattern, "/a%20b");
});

test("a zero or sub-floor price is refused, because it stores an intent the settle path refuses", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: 0 }]), /cannot settle/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: -1 }]), /cannot settle/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: 0.0000001 }]), /cannot settle/);
  // Exactly the floor is payable, so it is allowed.
  assert.equal(normalizePriceRules([{ pattern: "/a", priceUsdc: 0.000001 }])[0]?.priceUsdc, 0.000001);
});

test("a non-numeric or non-finite money field is refused", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: "5" }]), /not a number/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: Number.NaN }]), /not a number/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", priceUsdc: Infinity }]), /not a number/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", citationMultiplier: "5" }]), /not a number/);
  assert.throws(() => normalizePriceRules([{ pattern: "/a", citationMultiplier: 0 }]), /greater than zero/);
});

test("a rule that overrides neither field is refused", () => {
  assert.throws(() => normalizePriceRules([{ pattern: "/a" }]), /would change nothing/);
  // Explicit nulls read as "not set" — the shape a JSON round trip through a form produces.
  assert.throws(
    () => normalizePriceRules([{ pattern: "/a", priceUsdc: null, citationMultiplier: null }]),
    /would change nothing/,
  );
});

test("each money field may be set alone", () => {
  const [priceOnly] = normalizePriceRules([{ pattern: "/a", priceUsdc: 0.05 }]);
  assert.equal(priceOnly?.priceUsdc, 0.05);
  assert.equal(priceOnly?.citationMultiplier, undefined);
  const [multOnly] = normalizePriceRules([{ pattern: "/a", citationMultiplier: 12 }]);
  assert.equal(multOnly?.priceUsdc, undefined);
  assert.equal(multOnly?.citationMultiplier, 12);
});

test("the list and pattern length caps hold", () => {
  const many = Array.from({ length: MAX_PRICE_RULES + 1 }, (_, i) => ({ pattern: `/p${i}`, priceUsdc: 1 }));
  assert.throws(() => normalizePriceRules(many), /exceeds 50/);
  assert.equal(normalizePriceRules(many.slice(0, MAX_PRICE_RULES)).length, MAX_PRICE_RULES);
  assert.throws(
    () => normalizePriceRules([{ pattern: `/${"a".repeat(MAX_PATTERN_LEN)}`, priceUsdc: 1 }]),
    /too long/,
  );
});

/* ── the read path ─────────────────────────────────────────────────────────── */

test("resolve returns undefined when there is nothing to resolve", () => {
  assert.equal(resolvePriceRule(undefined, "/a"), undefined);
  assert.equal(resolvePriceRule([], "/a"), undefined);
  assert.equal(resolvePriceRule([{ pattern: "/a", priceUsdc: 1 }], undefined), undefined);
  assert.equal(resolvePriceRule([{ pattern: "/a", priceUsdc: 1 }], "/b"), undefined);
});

test("resolve uses RFC 9309 semantics, not glob semantics", () => {
  // The distinction that matters: `*` crosses `/`. Under a filesystem glob this would miss, and
  // a priced paper three levels deep would be quoted at the site base.
  const rules = normalizePriceRules([{ pattern: "/papers/*", priceUsdc: 0.05 }]);
  assert.equal(resolvePriceRule(rules, "/papers/2026/03/quantum")?.priceUsdc, 0.05);
  // A bare prefix matches its whole subtree, and does not match a sibling.
  const bare = normalizePriceRules([{ pattern: "/papers", priceUsdc: 0.05 }]);
  assert.equal(resolvePriceRule(bare, "/papers/x")?.priceUsdc, 0.05);
  assert.equal(resolvePriceRule(bare, "/blog/x"), undefined);
});

test("an unnormalised list still resolves, in the caller's own order", () => {
  // Normalisation is the write path's job; the read path never re-sorts, because it runs on
  // every priced request. This documents what happens to a hand-built list rather than
  // pretending it cannot occur.
  const handBuilt = [
    { pattern: "/", priceUsdc: 0.01 },
    { pattern: "/papers/*", priceUsdc: 0.05 },
  ];
  assert.equal(resolvePriceRule(handBuilt, "/papers/x")?.priceUsdc, 0.01);
});

// ── normalizePathPatterns — the list form a licence scope uses ────────────────
// The single-pattern half is already exercised through normalizePriceRules above; these
// cover what only the list form owns: the ceiling, dedupe, ordering, and the label that
// tells a caller WHICH list is wrong.

test("a pattern list comes back most-specific-first", () => {
  assert.deepEqual(normalizePathPatterns(["/essays/*", "/essays/2026/*"], "licence scope", 10), [
    "/essays/2026/*",
    "/essays/*",
  ]);
});

test("the list ceiling belongs to the caller, not the validator", () => {
  assert.throws(() => normalizePathPatterns(["/a", "/b"], "licence scope", 1), /too many licence scope patterns \(max 1\)/);
});

test("one pattern twice in a scope has no resolution order, so it is refused", () => {
  assert.throws(() => normalizePathPatterns(["/a/*", "/a/*"], "licence scope", 10), /listed twice/);
});

test("the label names the list the caller got wrong", () => {
  assert.throws(() => normalizePathPatterns(["essays/*"], "licence scope", 10), /licence scope "essays\/\*" must start with "\/"/);
  assert.throws(() => normalizePathPatterns([" "], "price rule", 10), /a price rule has an empty pattern/);
});

test("a trimmed pattern is what gets stored, so trailing whitespace cannot fork a scope", () => {
  assert.deepEqual(normalizePathPatterns(["  /essays/*  "], "licence scope", 10), ["/essays/*"]);
});
