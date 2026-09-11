/**
 * The settlement-ref classifier — the one implementation three planes used to spell separately.
 *
 * The `mock` case is the one with teeth: `PAYMENT_MODE=mock` is the DEFAULT, so before this module
 * existed every dev, demo and stdio read came back tagged `transferId` — "real money, batch lands
 * later" — for a reference that is proof of nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTxHash, settlementRefKind } from "./settlement-ref.ts";

const TX = `0x${"a".repeat(64)}`;

test("isTxHash accepts exactly 0x + 64 hex, either case", () => {
  assert.equal(isTxHash(TX), true);
  assert.equal(isTxHash(`0x${"A".repeat(64)}`), true);
  assert.equal(isTxHash(`0x${"a".repeat(63)}`), false, "63 hex is not a hash");
  assert.equal(isTxHash(`0x${"a".repeat(65)}`), false, "65 hex is not a hash");
  assert.equal(isTxHash("a".repeat(64)), false, "missing 0x");
  assert.equal(isTxHash(`0x${"g".repeat(64)}`), false, "not hex");
  assert.equal(isTxHash(""), false);
});

test("a Circle Gateway transfer id is a transferId, never a txHash", () => {
  // The shape the batching facilitator actually returns.
  assert.equal(settlementRefKind("6b1e5a2c-0f3d-4a7e-9c11-2f8b7d4e1a55"), "transferId");
});

test("a mock settlement is labelled mock — the DEFAULT payment mode's output", () => {
  // `settleMock()` emits `mock-<8hex>-<amount>`.
  assert.equal(settlementRefKind("mock-a1b2c3d4-1000"), "mock");
});

test("a real transaction hash is a txHash, and is the ONLY kind that is on-chain evidence", () => {
  assert.equal(settlementRefKind(TX), "txHash");
});

test("an absent ref is `none`, never a guess", () => {
  assert.equal(settlementRefKind(undefined), "none");
  assert.equal(settlementRefKind(null), "none");
  assert.equal(settlementRefKind(""), "none");
});

test("this module imports nothing — the constraint that lets a browser bundle use it", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./settlement-ref.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  assert.equal(
    /(?:^|\n)\s*import[\s({]/.test(code),
    false,
    "settlement-ref.ts gained an import — it would drag config (and viem) into every consumer that needs only this rule",
  );
});
