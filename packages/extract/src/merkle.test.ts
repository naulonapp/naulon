import assert from "node:assert/strict";
import { test } from "node:test";
import { inclusionProof, leafHash, merkleRoot, verifyInclusion } from "./merkle.ts";

const S = ["One.", "Two.", "Three.", "Four.", "Five."];
const L = S.map((s, i) => leafHash(i, s));

test("every leaf proves into the root, for every tree size 1 to 17", () => {
  for (let n = 1; n <= 17; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash(i, `s${i}.`));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) assert.ok(verifyInclusion(root, i, n, `s${i}.`, inclusionProof(leaves, i)), `${n}/${i}`);
  }
});

test("a proof fails for a changed sentence, a moved index, a different count or a trimmed proof", () => {
  const root = merkleRoot(L);
  const p = inclusionProof(L, 2);
  assert.ok(verifyInclusion(root, 2, 5, "Three.", p));
  assert.equal(verifyInclusion(root, 2, 5, "Three!", p), false);
  assert.equal(verifyInclusion(root, 3, 5, "Three.", p), false);
  assert.equal(verifyInclusion(root, 2, 6, "Three.", p), false);
  assert.equal(verifyInclusion(root, 2, 5, "Three.", p.slice(1)), false);
  assert.equal(verifyInclusion(root, 2, 5, "Three.", [...p, p[0]!]), false);
  assert.equal(verifyInclusion(root, 7, 5, "Three.", p), false);
});

test("the root binds the leaf count, and leaves are domain-separated from nodes", () => {
  assert.notEqual(merkleRoot([L[0]!]), L[0]);
  // A 3-leaf tree promotes its odd leaf; a 4-leaf tree whose 4th leaf repeats the 3rd must not share its root.
  assert.notEqual(merkleRoot(L.slice(0, 3)), merkleRoot([...L.slice(0, 3), L[2]!]));
  assert.notEqual(leafHash(0, "x"), leafHash(1, "x"));
  assert.throws(() => merkleRoot([]));
  assert.throws(() => inclusionProof(L, 5));
});

test("hashes are lowercase hex SHA-256", () => {
  assert.match(leafHash(0, "x"), /^[0-9a-f]{64}$/);
  assert.match(merkleRoot(L), /^[0-9a-f]{64}$/);
});
