/**
 * The naulon → IA settlement emit is money-truth: IA stores these events as the
 * canonical earnings ledger. These tests pin the invariants IA enforces server-
 * side, so a violation fails here (offline) instead of as a 400/401 in prod.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { buildSettlementBody, signSettlement } from "./settlementEmit.ts";
import type { AttributedEvent, Usdc, WalletAddress } from "./types.ts";

const NOW = 1_700_000_000_000;
const A = "0x1111111111111111111111111111111111111111" as WalletAddress;
const B = "0x2222222222222222222222222222222222222222" as WalletAddress;
const PAYER = "0x3333333333333333333333333333333333333333" as WalletAddress;
const CHAIN = 5042002;

function eventWith(payees: AttributedEvent["payees"], amount: number, payer = PAYER): AttributedEvent {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    slug: "on-stillness",
    kind: "citation",
    amount: amount as Usdc,
    payees,
    payerAddress: payer,
    settlementRef: "0xfeed",
    at: NOW,
  };
}

test("solo author: gross maps whole, single primary, eventId is the stable id", () => {
  const body = buildSettlementBody(eventWith([{ authorId: "mira", wallet: A, share: 1 }], 0.005), CHAIN);
  assert.equal(body.eventId, "11111111-2222-4333-8444-555555555555");
  assert.equal(body.grossAmount, "5000"); // 0.005 USDC = 5000 micro
  assert.equal(body.splits.length, 1);
  assert.equal(body.splits[0]!.amount, "5000");
  assert.equal(body.splits[0]!.primary, true);
  assert.equal(body.paidTo, A);
  assert.equal(body.payer, PAYER);
  assert.equal(body.settledAt, new Date(NOW).toISOString());
});

test("co-authors: splits sum EXACTLY to grossAmount and exactly one is primary", () => {
  // A 1/3 : 2/3 split of 1 micro-indivisible amount stresses the remainder path.
  const body = buildSettlementBody(
    eventWith(
      [
        { authorId: "mira", wallet: A, share: 1 / 3 },
        { authorId: "ravi", wallet: B, share: 2 / 3 },
      ],
      0.000001, // 1 micro-unit — cannot divide; remainder must land on the larger share
    ),
    CHAIN,
  );
  const sum = body.splits.reduce((s, x) => s + Number(x.amount), 0);
  assert.equal(String(sum), body.grossAmount, "Σ splits === gross (IA 400s otherwise)");
  assert.equal(body.grossAmount, "1");
  assert.equal(body.splits.filter((s) => s.primary).length, 1, "exactly one primary");
  // primary === on-chain recipient === largest SHARE (ravi, B), regardless of
  // where the indivisible dust micro lands (splitMicro breaks the all-zero tie
  // positionally). The recorded split can differ from the on-chain leg — that
  // reconciliation is IA's job (the known x402 single-payTo constraint).
  assert.equal(body.paidTo, B);
  assert.equal(body.splits.find((s) => s.wallet === B)!.primary, true);
  // The single dust micro is conserved on exactly one split.
  assert.equal(body.splits.filter((s) => s.amount === "1").length, 1);
  assert.equal(body.splits.filter((s) => s.amount === "0").length, 1);
});

test("a zero-address payer is reported as null, not a bogus wallet", () => {
  const body = buildSettlementBody(
    eventWith([{ authorId: "mira", wallet: A, share: 1 }], 0.005, "0x0000000000000000000000000000000000000000" as WalletAddress),
    CHAIN,
  );
  assert.equal(body.payer, null);
});

test("signature is HMAC-SHA256 over `${ts}.${rawBody}` and reproduces IA's check", () => {
  const body = buildSettlementBody(eventWith([{ authorId: "mira", wallet: A, share: 1 }], 0.005), CHAIN);
  const raw = JSON.stringify(body);
  const { timestamp, signature } = signSettlement(raw, "shh", 1_700_000_000);
  assert.equal(timestamp, "1700000000");
  const expected = "sha256=" + createHmac("sha256", "shh").update(`1700000000.${raw}`).digest("hex");
  assert.equal(signature, expected);
});
