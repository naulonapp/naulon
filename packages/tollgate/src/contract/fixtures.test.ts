/**
 * The committed contract files are exactly what the gate generates today. A change to decide(),
 * slugForScope(), a route schema or the publisher record that is not followed by
 * `npm run contract:fixtures` fails here, before any other runtime is tested against a stale contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAccessCases, buildScopeCases, contractFiles, termsCombinations, VARIANTS } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

for (const f of await contractFiles()) {
  test(`${f.path} is current (npm run contract:fixtures)`, () => {
    assert.equal(readFileSync(join(root, f.path), "utf8"), f.content);
  });
}

test("every access subject has one expectation per terms combination and variant", async () => {
  const doc = await buildAccessCases();
  for (const s of doc.subjects) assert.equal(s.expect.length, termsCombinations().length * VARIANTS.length, s.name);
  assert.match(doc.subjects.map((s) => s.expect).join(""), /^[bfc]+$/);
});

test("a person reads free under every rule set", async () => {
  const chrome = (await buildAccessCases()).subjects.find((s) => s.name === "Chrome on macOS");
  assert.ok(chrome && /^f+$/.test(chrome.expect));
});

test("discovery stays free in every scope", () => {
  const doc = buildScopeCases();
  for (const p of ["/robots.txt", "/sitemap.xml", "/feed/", "/rss.xml", "/_naulon/quote", "/.well-known/x402"]) {
    const j = doc.paths.indexOf(p);
    for (const row of doc.expect) assert.equal(row[j], null, p);
  }
});
