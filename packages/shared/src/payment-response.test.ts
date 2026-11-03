import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePaymentResponse, encodePaymentResponse } from "./payment-response.ts";

const b64 = (s: string): string => Buffer.from(s).toString("base64");

test("what the gate writes, a buyer reads as settled, with its transaction", () => {
  const header = encodePaymentResponse({ transaction: "0xabc", network: "eip155:5042002", payer: "0x1" });
  assert.deepEqual(decodePaymentResponse(header), { transaction: "0xabc" });
  assert.deepEqual(decodePaymentResponse(encodePaymentResponse({ network: "n", payer: "p" })), {}, "settled without a ref");
});

test("a transaction without a success flag still counts; an explicit failure never does", () => {
  assert.deepEqual(decodePaymentResponse(b64(JSON.stringify({ transaction: "tid-1" }))), { transaction: "tid-1" });
  assert.equal(decodePaymentResponse(b64(JSON.stringify({ success: false, transaction: "0xabc" }))), null);
});

test("no header, an empty object, or something that is not a JSON object is no receipt", () => {
  for (const raw of [undefined, null, "", b64("{}"), b64("not json"), b64("42"), b64("null"), b64("[1]"), b64(JSON.stringify({ transaction: "" }))]) {
    assert.equal(decodePaymentResponse(raw), null, String(raw));
  }
});
