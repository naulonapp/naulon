import test from "node:test";
import assert from "node:assert/strict";
import { classifyPaymentFailure, PAYMENT_FAILURE_REASONS } from "./paymentfailure.ts";

// The strings below are copied VERBATIM from packages/tollgate/src/x402.ts — they are the real
// `VerifyResult.error` values the settle path returns. If one is reworded there and not here, the
// classifier silently degrades to `settlement_failed`, which is the failure mode this whole file
// exists to prevent (a counted failure nobody can explain).

test("the facilitator's balance rejection is insufficient_funds — the prod 2026-08-03 string", () => {
  // The exact error that burned 12000 micro: publisher pinned to Base mainnet, session funded on
  // arcTestnet, so the USDC transfer reverted for want of balance.
  assert.equal(classifyPaymentFailure("author leg settle failed: insufficient_balance"), "insufficient_funds");
});

test("balance shortfalls are recognised across the wordings a facilitator/ERC-20 can return", () => {
  for (const s of [
    "author leg settle failed: insufficient_balance",
    "ERC20: transfer amount exceeds balance",
    "not enough funds",
    "balance too low",
    "insufficient allowance",
  ]) {
    assert.equal(classifyPaymentFailure(s), "insufficient_funds", `should be a shortfall: ${s}`);
  }
});

test("a signed authorization that does not match the advertised toll is authorization_invalid", () => {
  assert.equal(
    classifyPaymentFailure("leg 0: authorization (to 0xabc, value 5000) != requirements (payTo 0xdef, amount 3000)"),
    "authorization_invalid",
  );
  assert.equal(classifyPaymentFailure("leg 1 (0xdef): verification failed"), "authorization_invalid");
  assert.equal(classifyPaymentFailure("leg 0 (0xdef): nonce already used"), "authorization_invalid");
});

test("an undecodable or structurally wrong payment is malformed_payment", () => {
  for (const s of [
    "malformed payment-signature",
    "leg 0: malformed memo payload (need {authorization, signature})",
    "leg count mismatch: 1 signed, 2 required",
    "leg 0: missing payer",
    "no settlement legs",
  ]) {
    assert.equal(classifyPaymentFailure(s), "malformed_payment", `should be malformed: ${s}`);
  }
});

test("a chain that cannot carry the settlement is network_unsupported", () => {
  assert.equal(classifyPaymentFailure("network base has no Memo predeploy"), "network_unsupported");
  assert.equal(
    classifyPaymentFailure("RELAYER_PRIVATE_KEY_MAINNET required for mainnet memo-network settlement"),
    "network_unsupported",
  );
});

test("an unrecognised failure degrades to settlement_failed — never to a wrong specific reason", () => {
  assert.equal(classifyPaymentFailure("something nobody has seen before"), "settlement_failed");
  assert.equal(classifyPaymentFailure(""), "settlement_failed");
  assert.equal(classifyPaymentFailure(undefined), "settlement_failed");
});

// THE SECURITY PROPERTY. The raw settle error embeds a payee address and the leg amount
// ("leg 0 (0xdef): …", "authorization (to 0xabc, value 5000)"). The observation is shown to the
// PUBLISHER, so returning the raw string would hand them another party's address and amounts.
// A closed enum makes that structurally impossible rather than a matter of care.
test("SECURITY: the classifier can only ever return a member of the closed set — no raw text escapes", () => {
  const leaky = [
    "leg 0: authorization (to 0xDEADBEEF, value 999999) != requirements (payTo 0xCAFEBABE, amount 3000)",
    "leg 1 (0x115CD5f9f74b50d148D9C0aAaeA16902861f313E): verification failed",
    "author leg settle failed: insufficient_balance for 0x73ebc08391D37e5f6FEf39AD406810C7cA51f231",
  ];
  for (const s of leaky) {
    const r = classifyPaymentFailure(s);
    assert.ok(PAYMENT_FAILURE_REASONS.includes(r), `must be a closed-set member, got ${r}`);
    assert.doesNotMatch(r, /0x[0-9a-fA-F]{6,}/, "an address must never survive classification");
    assert.doesNotMatch(r, /\d{4,}/, "an amount must never survive classification");
  }
});
