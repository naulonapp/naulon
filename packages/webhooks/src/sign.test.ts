import { test } from "node:test";
import assert from "node:assert/strict";
import { signPayload, verifyPayload } from "./sign.ts";

const SECRET = "whsec_test_abc";
const BODY = JSON.stringify({ id: "d1", type: "anomaly.detected", data: { a: 1 } });

test("signPayload produces t=..,v1=<64hex> that verifies", () => {
  const t = 1_700_000_000;
  const header = signPayload(SECRET, BODY, t);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(verifyPayload(SECRET, BODY, header, t), true);
});

test("verify rejects a tampered body", () => {
  const t = 1_700_000_000;
  const header = signPayload(SECRET, BODY, t);
  assert.equal(verifyPayload(SECRET, BODY + " ", header, t), false);
});

test("verify rejects the wrong secret", () => {
  const t = 1_700_000_000;
  const header = signPayload(SECRET, BODY, t);
  assert.equal(verifyPayload("whsec_wrong", BODY, header, t), false);
});

test("verify rejects a timestamp outside the 300s tolerance", () => {
  const t = 1_700_000_000;
  const header = signPayload(SECRET, BODY, t);
  assert.equal(verifyPayload(SECRET, BODY, header, t + 301), false);
  assert.equal(verifyPayload(SECRET, BODY, header, t + 299), true);
});

test("verify is total-failure-safe on malformed headers", () => {
  const t = 1_700_000_000;
  for (const bad of ["", "garbage", "t=,v1=", "v1=abc", "t=abc,v1=" + "z".repeat(64)]) {
    assert.equal(verifyPayload(SECRET, BODY, bad, t), false);
  }
});
