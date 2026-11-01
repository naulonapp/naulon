import { test } from "node:test";
import assert from "node:assert/strict";
import { toObservationEvent, type InAppObservation } from "./observation.ts";

const base = (over?: Partial<InAppObservation>): InAppObservation => ({
  publisherId: "pub_a",
  host: "h.test",
  slug: "essays/x",
  verdict: "paid",
  classifiedAs: "agent",
  at: 1_000,
  ...over,
});

test("shapes the same event the gate writes — id minted here, not supplied", () => {
  const e = toObservationEvent(base({ kind: "citation", priceUsdc: 0.003 }), "fixed-id");
  assert.deepEqual(e, {
    id: "fixed-id",
    publisherId: "pub_a",
    host: "h.test",
    slug: "essays/x",
    verdict: "paid",
    classifiedAs: "agent",
    at: 1_000,
    kind: "citation",
    price: 0.003,
  });
});

// Without the reason, a publisher's own settlement misconfiguration looks identical to a run of
// buyers without funds. Both writers (this API and the gate's settle tail) carry it.
test("a payment-failed observation carries the classified failureReason through to the wire event", () => {
  const e = toObservationEvent(base({ verdict: "payment-failed", priceUsdc: 0.003, failureReason: "insufficient_funds" }), "f1");
  assert.equal(e.failureReason, "insufficient_funds");
  assert.equal(e.verdict, "payment-failed");
});

// The field is projected ONLY for the verdict it explains. Anything else is a caller bug, and a
// `served-free` row carrying "insufficient_funds" would be actively misleading on the Audit page.
test("failureReason is dropped on every verdict except payment-failed", () => {
  for (const verdict of ["paid", "served-free", "denied", "blocked", "agent-reread"] as const) {
    const e = toObservationEvent(base({ verdict, failureReason: "insufficient_funds" }));
    assert.equal(e.failureReason, undefined, `${verdict} must not carry a failure reason`);
  }
});

test("mints a distinct uuid per call — a retry can never overwrite an unrelated row", () => {
  const a = toObservationEvent(base());
  const b = toObservationEvent(base());
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
});

test("the agent block maps onto the gate's identity fields", () => {
  const e = toObservationEvent(
    base({ agent: { ua: "GPTBot/1.0", classifyReason: "ua-pattern:bot", verified: true, verifiedAgent: "chatgpt.com", sigInvalid: false } }),
  );
  assert.equal(e.agentUa, "GPTBot/1.0");
  assert.equal(e.classifyReason, "ua-pattern:bot");
  assert.equal(e.verified, true);
  assert.equal(e.verifiedAgent, "chatgpt.com");
  assert.equal(e.sigInvalid, false);
});

test("absent optional fields are omitted, not written as undefined", () => {
  const e = toObservationEvent(base());
  assert.equal("kind" in e, false);
  assert.equal("price" in e, false);
  assert.equal("agentUa" in e, false);
});

test("oversized strings are truncated, never dropped — a long UA must not cost the row", () => {
  const e = toObservationEvent(base({ agent: { ua: "x".repeat(2000) }, slug: "s".repeat(2000) }));
  assert.equal(e.agentUa?.length, 512);
  assert.equal(e.slug.length, 512);
});

test("a nonsense price is dropped, and the observation still lands", () => {
  for (const priceUsdc of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const e = toObservationEvent(base({ priceUsdc }));
    assert.equal("price" in e, false);
    assert.equal(e.verdict, "paid");
  }
});

test("a zero price is kept — free-but-tolled is a real quote, not a missing one", () => {
  assert.equal(toObservationEvent(base({ priceUsdc: 0 })).price, 0);
});

/** Drain the microtask queue. The emitter is fire-and-forget by design, so an assertion
 *  about what it did has to wait for the queue rather than a guessed number of ticks. */

test("toObservationEvent carries the request path when the report had one", () => {
  assert.equal(toObservationEvent(base({ path: "/essays/x" })).path, "/essays/x");
  assert.equal(toObservationEvent(base()).path, undefined);
});

test("the identity fields reach the stored event, and are absent when not reported", () => {
  const e = toObservationEvent(base({ verdict: "denied", identityCheck: "forged", claimedOperator: "google", forgedFrom: "9.9.9.0/24" }), "i1");
  assert.equal(e.identityCheck, "forged");
  assert.equal(e.claimedOperator, "google");
  assert.equal(e.forgedFrom, "9.9.9.0/24");
  const plain = toObservationEvent(base({ verdict: "denied" }), "i2");
  for (const k of ["identityCheck", "claimedOperator", "forgedFrom"]) assert.equal(k in plain, false, k);
});

test("the observe facts reach the stored event", () => {
  const e = toObservationEvent(base({ priceUsdc: 0.001, observeOnly: true, crawlerBudget: "within", paymentPresented: true }), "o1");
  assert.equal(e.observeOnly, true);
  assert.equal(e.crawlerBudget, "within");
  assert.equal(e.paymentPresented, true);
  const plain = toObservationEvent(base({ priceUsdc: 0.001 }), "o2");
  assert.equal("observeOnly" in plain, false);
});

test("a paid row names its licence; any other verdict, or a non-uuid, does not", () => {
  const jti = "0b7c4f0e-2a8f-4c55-9a4e-1f0d6c2b9e11";
  assert.equal(toObservationEvent(base({ verdict: "paid", licenseJti: jti })).licenseJti, jti);
  assert.equal(toObservationEvent(base({ verdict: "denied", licenseJti: jti })).licenseJti, undefined);
  assert.equal(toObservationEvent(base({ verdict: "paid", licenseJti: "../other-tenant" })).licenseJti, undefined);
});
