import { test } from "node:test";
import assert from "node:assert/strict";
import type { WalletAddress } from "@naulon/shared";
import { buildSettlementPayload, type SettlementFacts } from "./payload.ts";

const W = (s: string): WalletAddress => s as WalletAddress;

function facts(over: Partial<SettlementFacts> = {}): SettlementFacts {
  return {
    tenant: "acme",
    host: "acme.example.com",
    acked: 4,
    pending: 0,
    window: { toMs: 1_719_000_000_000, spanMs: 60_000 },
    events: [
      {
        slug: "essay-1",
        kind: "citation",
        amountMicro: 6_000,
        settlementRef: "0xref1",
        payees: [
          { authorId: "a1", wallet: W("0xAuthorA"), share: 0.5 },
          { authorId: "a2", wallet: W("0xAuthorB"), share: 0.5 },
        ],
      },
      {
        slug: "essay-2",
        kind: "read",
        amountMicro: 2_000,
        settlementRef: "0xref1",
        payees: [{ authorId: "a1", wallet: W("0xAuthorA"), share: 1 }],
      },
    ],
    operatorLegs: [
      { payTo: "0xOperator", microUsdc: 800, settled: true, settlementRef: "0xopref" },
    ],
    ...over,
  };
}

test("summary is byte-identical to today's { tenant, acked, pending }", () => {
  const out = buildSettlementPayload("summary", facts());
  assert.deepEqual(out, { tenant: "acme", acked: 4, pending: 0 });
  // key order matters for the HMAC of existing endpoints — must not change
  assert.equal(JSON.stringify(out), JSON.stringify({ tenant: "acme", acked: 4, pending: 0 }));
});

test("detailed: gross = Σ all legs (author payees + additive operator fee)", () => {
  const out = buildSettlementPayload("detailed", facts()) as Record<string, any>;
  // author gross = 6000 + 2000 = 8000; operator = 800 (additive, custody-free) => 8800
  assert.equal(out.gross.microUsdc, 8_800);
  assert.equal(out.gross.usdc, "0.008800");
  const authorSum = out.legs
    .filter((l: any) => l.role === "author")
    .reduce((s: number, l: any) => s + l.microUsdc, 0);
  assert.equal(authorSum, 8_000); // author legs reconcile to the event gross exactly (splitMicro)
});

test("detailed: author payees aggregated by wallet, biggest-first, settled=true", () => {
  const out = buildSettlementPayload("detailed", facts()) as Record<string, any>;
  const authors = out.legs.filter((l: any) => l.role === "author");
  assert.equal(authors.length, 2);
  // A = 3000 (half of 6000) + 2000 = 5000 ; B = 3000
  assert.equal(authors[0].payTo, "0xAuthorA");
  assert.equal(authors[0].microUsdc, 5_000);
  assert.equal(authors[1].microUsdc, 3_000);
  assert.ok(authors.every((l: any) => l.settled === true));
  // both events share one ref => the leg carries it
  assert.equal(authors[0].settlementRef, "0xref1");
});

test("detailed: an author paid across DISTINCT refs gets settlementRef=null (never faked)", () => {
  const out = buildSettlementPayload("detailed", facts({
    events: [
      { slug: "s1", kind: "citation", amountMicro: 1_000, settlementRef: "0xa", payees: [{ authorId: "a1", wallet: W("0xW"), share: 1 }] },
      { slug: "s2", kind: "citation", amountMicro: 1_000, settlementRef: "0xb", payees: [{ authorId: "a1", wallet: W("0xW"), share: 1 }] },
    ],
    operatorLegs: [],
  })) as Record<string, any>;
  const leg = out.legs.find((l: any) => l.payTo === "0xW");
  assert.equal(leg.settlementRef, null);
  assert.deepEqual(out.settlementRefs, ["0xa", "0xb"]); // distinct, surfaced at top level
});

test("detailed: NO unconfirmed field is null-stuffed (no txUrl key anywhere)", () => {
  const json = JSON.stringify(buildSettlementPayload("detailed", facts()));
  assert.equal(json.includes("txUrl"), false);
  assert.equal(json.includes("coauthor"), false); // co-author deferred legs omitted v1
});

test("detailed: empty settlement (no events, no legs) → zeroed body, no throw", () => {
  const out = buildSettlementPayload("detailed", facts({ events: [], operatorLegs: [], acked: 0 })) as Record<string, any>;
  assert.equal(out.gross.microUsdc, 0);
  assert.equal(out.gross.usdc, "0.000000");
  assert.deepEqual(out.legs, []);
  assert.deepEqual(out.settlementRefs, []);
  assert.deepEqual(out.citations, { settled: 0, pending: 0 });
});

test("detailed: operator leg carries its real settlementRef + settled state", () => {
  const out = buildSettlementPayload("detailed", facts()) as Record<string, any>;
  const op = out.legs.find((l: any) => l.role === "operator");
  assert.equal(op.payTo, "0xOperator");
  assert.equal(op.microUsdc, 800);
  assert.equal(op.settled, true);
  assert.equal(op.settlementRef, "0xopref");
});
