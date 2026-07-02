/**
 * BUY-0 — wayfarer is a consumable library.
 *
 * Proves the package can be imported BY NAME (`@naulon/wayfarer`, via the
 * package.json `exports` map) and that it surfaces the real pipeline API the
 * buy-side MCP (BUY-1) and the cloud will consume. The stage names in the
 * buy-side spec are conceptual; these are the genuine exported symbols:
 *   quote      → probePrice (free 402 probe, no spend)
 *   pay        → selectBuyer (the Buyer seam: mock | memo | gateway)
 *   read-held  → rereadWithLicense (free re-read of a held live license)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as wayfarer from "@naulon/wayfarer";
import type { RunResult, DecisionPolicy, Source } from "@naulon/wayfarer";

test("the package is importable by name and exposes the buy-side pipeline API", () => {
  // pipeline entry point
  assert.equal(typeof wayfarer.run, "function");

  // the discrete stages an MCP host drives over real data
  assert.equal(typeof wayfarer.discover, "function");
  assert.equal(typeof wayfarer.appraise, "function");
  assert.equal(typeof wayfarer.probePrice, "function"); // "quote" — free 402 probe
  assert.equal(typeof wayfarer.decide, "function");
  assert.equal(typeof wayfarer.selectBuyer, "function"); // "pay" — Buyer seam
  assert.equal(typeof wayfarer.rereadWithLicense, "function"); // "read-held"

  // a default policy consumers extend (BUY-3)
  assert.equal(typeof wayfarer.DEFAULT_POLICY, "object");
});

// Compile-time guard: forces tsc to verify the type re-exports exist on the
// public barrel (a missing type export fails the typecheck, not this runtime test).
const _typeGuard: { result: RunResult | null; policy: DecisionPolicy | null; source: Source | null } = {
  result: null,
  policy: null,
  source: null,
};
void _typeGuard;
