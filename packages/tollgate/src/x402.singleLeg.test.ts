import assert from "node:assert/strict";
import { test } from "node:test";
import { isSingleLegPayment } from "./x402.ts";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

test("a bare object payload is a single-leg payment", () => {
  assert.equal(isSingleLegPayment(b64({ x402Version: 2 })), true);
});

test("a per-leg array is not", () => {
  assert.equal(isSingleLegPayment(b64([{ x402Version: 2 }])), false);
});

test("null, a number and undecodable input are not", () => {
  assert.equal(isSingleLegPayment(b64(null)), false);
  assert.equal(isSingleLegPayment(b64(7)), false);
  assert.equal(isSingleLegPayment("%%%not-base64-json"), false);
});
