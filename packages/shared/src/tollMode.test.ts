import { test } from "node:test";
import assert from "node:assert/strict";
import { chargesReads } from "./publisher.ts";
import { effectiveVerdict } from "./types.ts";

test("an unset mode charges, exactly as before the field existed", () => {
  assert.equal(chargesReads({}), true);
});

test("charge charges", () => {
  assert.equal(chargesReads({ tollMode: "charge" }), true);
});

test("observe does not charge", () => {
  assert.equal(chargesReads({ tollMode: "observe" }), false);
});

test("an unknown value charges rather than going quiet", () => {
  // A value that slipped past a parser must fail toward the status quo.
  assert.equal(chargesReads({ tollMode: "OBSERVE" as never }), true);
});


test("an observed read's effective verdict is a free read; every other row keeps its verdict", () => {
  const base = { id: "x", host: "h", slug: "s", classifiedAs: "agent" as const, at: 1 };
  assert.equal(effectiveVerdict({ ...base, verdict: "denied", observeOnly: true }), "served-free");
  assert.equal(effectiveVerdict({ ...base, verdict: "denied" }), "denied");
  assert.equal(effectiveVerdict({ ...base, verdict: "paid" }), "paid");
});
