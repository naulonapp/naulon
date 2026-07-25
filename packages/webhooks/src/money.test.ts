import { test } from "node:test";
import assert from "node:assert/strict";
import { microToUsdc } from "./money.ts";

test("microToUsdc formats whole and fractional micro-USDC to 6dp", () => {
  assert.equal(microToUsdc(0), "0.000000");
  assert.equal(microToUsdc(1_000_000), "1.000000");
  assert.equal(microToUsdc(1_500_000), "1.500000");
  assert.equal(microToUsdc(1), "0.000001");
  assert.equal(microToUsdc(123_456_789), "123.456789");
});

test("microToUsdc preserves the sign without a float divide", () => {
  assert.equal(microToUsdc(-2_500_000), "-2.500000");
  assert.equal(microToUsdc(-1), "-0.000001");
});
