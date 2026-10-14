/**
 * Merkle proofs over sentence leaves, so one quoted sentence can be checked against a published
 * root without disclosing any other sentence of the text.
 *
 * leaf  = SHA-256(0x00 ‖ "naulon-sentence-v1" ‖ u32be(index) ‖ UTF-8(sentence))
 * node  = SHA-256(0x01 ‖ left ‖ right); an odd node at the end of a level is promoted unchanged
 * root  = SHA-256(0x02 ‖ u32be(count) ‖ top)
 *
 * The index is inside the leaf, so a sentence cannot be claimed at another position, and the count
 * is inside the root, so a proof cannot be replayed against a tree of a different size. A proof is
 * verified from the index and count alone, without the text or the other leaves.
 */
import { createHash } from "node:crypto";

const LEAF_DOMAIN = Buffer.from("naulon-sentence-v1", "utf8");

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const sha = (...parts: Buffer[]): string => createHash("sha256").update(Buffer.concat(parts)).digest("hex");
const hex = (h: string): Buffer => Buffer.from(h, "hex");
const node = (left: string, right: string): string => sha(Buffer.from([1]), hex(left), hex(right));

export function leafHash(index: number, sentence: string): string {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError("leaf index out of range");
  return sha(Buffer.from([0]), LEAF_DOMAIN, u32(index), Buffer.from(sentence, "utf8"));
}

function levels(leaves: string[]): string[][] {
  if (leaves.length === 0) throw new RangeError("a Merkle tree needs at least one leaf");
  const out = [leaves];
  while (out[out.length - 1]!.length > 1) {
    const cur = out[out.length - 1]!;
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? node(cur[i]!, cur[i + 1]!) : cur[i]!);
    out.push(next);
  }
  return out;
}

export function merkleRoot(leaves: string[]): string {
  const top = levels(leaves).at(-1)![0]!;
  return sha(Buffer.from([2]), u32(leaves.length), hex(top));
}

/** Sibling hashes from the leaf up. A promoted node has no sibling at that level and adds nothing. */
export function inclusionProof(leaves: string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  const proof: string[] = [];
  let i = index;
  for (const level of levels(leaves).slice(0, -1)) {
    const sibling = i % 2 === 1 ? i - 1 : i + 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyInclusion(root: string, index: number, count: number, sentence: string, proof: string[]): boolean {
  if (!Number.isInteger(count) || count < 1 || count > 0xffffffff) return false;
  if (!Number.isInteger(index) || index < 0 || index >= count) return false;
  if (!/^[0-9a-f]{64}$/.test(root) || proof.some((p) => !/^[0-9a-f]{64}$/.test(p))) return false;
  let h = leafHash(index, sentence);
  let i = index;
  let n = count;
  let used = 0;
  while (n > 1) {
    if (i % 2 === 1) {
      const p = proof[used++];
      if (p === undefined) return false;
      h = node(p, h);
    } else if (i + 1 < n) {
      const p = proof[used++];
      if (p === undefined) return false;
      h = node(h, p);
    }
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  return used === proof.length && sha(Buffer.from([2]), u32(count), hex(h)) === root;
}
