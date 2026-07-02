import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateByContribution } from "./allocation.ts";

test("allocates the pool proportional to contribution", () => {
  const alloc = allocateByContribution([
    { slug: "big", contribution: 0.75 },
    { slug: "small", contribution: 0.25 },
  ], 1_000_000);
  assert.equal(alloc.find((a) => a.slug === "big")!.micro, 750_000);
  assert.equal(alloc.find((a) => a.slug === "small")!.micro, 250_000);
});

test("is dust-free: Σ micro === pool exactly (remainder to the largest share)", () => {
  const alloc = allocateByContribution([
    { slug: "a", contribution: 1 },
    { slug: "b", contribution: 1 },
    { slug: "c", contribution: 1 },
  ], 1000);
  assert.equal(alloc.reduce((s, a) => s + a.micro, 0), 1000); // no dust created or lost
  // 1000/3 = 333.33 → floors 333/333/333, remainder 1 to the largest (first by weight)
  assert.deepEqual(alloc.map((a) => a.micro).sort((x, y) => y - x), [334, 333, 333]);
});

test("a zero-contribution source gets nothing; the rest split the full pool", () => {
  const alloc = allocateByContribution([
    { slug: "useful", contribution: 0.9 },
    { slug: "dead", contribution: 0 },
  ], 500);
  assert.equal(alloc.find((a) => a.slug === "dead")!.micro, 0);
  assert.equal(alloc.find((a) => a.slug === "useful")!.micro, 500);
});

test("negative contributions are clamped to zero weight", () => {
  const alloc = allocateByContribution([
    { slug: "good", contribution: 0.5 },
    { slug: "noise", contribution: -0.3 },
  ], 200);
  assert.equal(alloc.find((a) => a.slug === "noise")!.micro, 0);
  assert.equal(alloc.find((a) => a.slug === "good")!.micro, 200);
});

test("a single cited source takes the whole pool", () => {
  const alloc = allocateByContribution([{ slug: "solo", contribution: 0.4 }], 777);
  assert.equal(alloc[0]!.micro, 777);
  assert.equal(alloc[0]!.weight, 1); // normalized to the only source
});

test("empty or all-zero contribution allocates nothing (pool unallocated)", () => {
  assert.deepEqual(allocateByContribution([], 1000), []);
  const allZero = allocateByContribution([
    { slug: "x", contribution: 0 },
    { slug: "y", contribution: 0 },
  ], 1000);
  assert.equal(allZero.reduce((s, a) => s + a.micro, 0), 0);
});

test("weights are the normalized 0..1 contribution shares", () => {
  const alloc = allocateByContribution([
    { slug: "a", contribution: 3 },
    { slug: "b", contribution: 1 },
  ], 4000);
  assert.equal(alloc.find((a) => a.slug === "a")!.weight, 0.75);
  assert.equal(alloc.find((a) => a.slug === "b")!.weight, 0.25);
});

test("dust-free invariant holds for many awkward weight/pool combinations", () => {
  // Deterministic LCG (no Math.random → reproducible) exercising odd primes,
  // lopsided weights, tiny pools, and many sources — the remainder path.
  let seed = 1234567;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 500; trial++) {
    const n = 1 + Math.floor(rand() * 12);
    const sources = Array.from({ length: n }, (_, i) => ({ slug: `s${i}`, contribution: rand() * 10 }));
    const pool = Math.floor(rand() * 1_000_003); // a prime bound → nasty remainders
    const alloc = allocateByContribution(sources, pool);
    const sum = alloc.reduce((s, a) => s + a.micro, 0);
    assert.equal(sum, pool, `trial ${trial}: Σmicro ${sum} !== pool ${pool}`);
    for (const a of alloc) assert.ok(a.micro >= 0 && Number.isInteger(a.micro), `negative/non-integer micro in trial ${trial}`);
  }
});
