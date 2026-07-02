/**
 * The shipped example credits graphs must stay valid: every fixture resolves to
 * payees whose shares sum to exactly 1. This couples the `examples/` adapters to
 * CI so a malformed graph (or a splitter regression) fails the build, and proves
 * the toll is publisher-agnostic — the same resolver handles both fixtures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePayees } from "./attribution.ts";
import type { ArticleCredits } from "./types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadFixture(rel: string): Record<string, ArticleCredits> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

const FIXTURES = [
  "examples/meridian/credits.json",
  "examples/cascade/credits.json",
];

for (const rel of FIXTURES) {
  test(`${rel}: every article's shares sum to exactly 1`, () => {
    const graph = loadFixture(rel);
    const slugs = Object.keys(graph);
    assert.ok(slugs.length > 0, "fixture is non-empty");
    for (const slug of slugs) {
      const payees = resolvePayees(graph[slug]!);
      const sum = payees.reduce((acc, p) => acc + p.share, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${slug}: shares sum to ${sum}, expected 1`);
      assert.ok(payees.length > 0, `${slug}: has at least one payee`);
    }
  });
}

test("cascade's 2-level nested composite collapses to the documented split", () => {
  const graph = loadFixture("examples/cascade/credits.json");
  const payees = resolvePayees(graph["how-vaccines-teach"]!);
  const byAuthor = Object.fromEntries(payees.map((p) => [p.authorId, p.share]));
  // the-immunology-desk (3) / mira (1) → 75% / 25%; desk re-splits okonkwo (1)
  // and the-bench-team (2); bench team re-splits petrova/haddad 50/50.
  assert.deepEqual(byAuthor, {
    okonkwo: 0.25,
    petrova: 0.25,
    haddad: 0.25,
    mira: 0.25,
  });
});
