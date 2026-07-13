/**
 * The scoped settlement drain (`drainSettlements(scope)`) is money-truth across a
 * boundary: a scoped sweep must re-send only the scoped publisher's unacked
 * settlements, to that publisher's origin, signed with that publisher's secret. A
 * scope leak would settle one author's earnings against another's ledger. These
 * tests pin that isolation offline — the contract a downstream embedder relies on.
 *
 * Paths + the ledger backend are set before any getConfig()/getSink() binds
 * (both cache on first read). NODE_ENV=test skips dotenv.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "naulon-drain-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.SETTLEMENT_OUTBOX_PATH = join(dir, "outbox.jsonl");
process.env.EVENTS_BACKEND = "jsonl";
// Leave CREDITS_SETTLEMENT_SECRET / ORIGIN_URL unset so the global fallback is
// dark — proving the passed scope, not ambient config, drives delivery.

const { ARC_TESTNET, buildSettlementBody, getSink, signSettlement } = await import("@naulon/shared");
const { drainSettlements } = await import("./settlementSink.ts");
import type { AttributedEvent, Usdc, WalletAddress } from "@naulon/shared";

const PAYER = "0x3333333333333333333333333333333333333333" as WalletAddress;
const AUTHOR = "0x1111111111111111111111111111111111111111" as WalletAddress;

function evt(id: string, publisherId: string): AttributedEvent {
  return {
    id,
    publisherId,
    slug: "on-stillness",
    kind: "read",
    amount: 1000 as Usdc,
    payees: [{ authorId: "author-1", wallet: AUTHOR, share: 1 }],
    payerAddress: PAYER,
    settlementRef: "0xfeed",
    at: 1_700_000_000_000,
  };
}

// Seed a two-publisher ledger through the same sink the drain reads.
const sink = getSink();
for (const e of [evt("a1", "publisher-a"), evt("b1", "publisher-b"), evt("a2", "publisher-a")]) {
  await sink.record(e);
}

interface Captured {
  url: string;
  timestamp: string;
  signature: string;
  body: string;
}

/** Swap global fetch for a recorder that 200s every settlement POST. */
function captureFetch(): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      timestamp: String((init?.headers as Record<string, string>)["X-Naulon-Timestamp"]),
      signature: String((init?.headers as Record<string, string>)["X-Naulon-Signature"]),
      body: String(init?.body),
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

test("drain scoped to a publisher delivers only that publisher's events, signed with its secret", async () => {
  const calls = captureFetch();
  const secretA = "secret-for-publisher-a";
  const originA = "https://a.example";

  const summary = await drainSettlements({ secret: secretA, originUrl: originA, publisherId: "publisher-a" });

  // Exactly publisher-a's two events, both to publisher-a's origin.
  assert.deepEqual(summary, { acked: 2, pending: 0 });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, `${originA}/api/credits/settlement`);
    // The signature verifies under publisher-a's secret over the exact body sent.
    const { signature } = signSettlement(c.body, secretA, Number(c.timestamp));
    assert.equal(c.signature, signature, "POST must be signed with the scoped publisher's secret");
  }
  // publisher-b's event was not touched in this sweep.
  assert.equal(calls.some((c) => c.body.includes('"on-stillness"') && c.url.includes("b.example")), false);
});

test("a publisher's body is the canonical settlement payload for its event", async () => {
  const calls = captureFetch();
  await drainSettlements({ secret: "s", originUrl: "https://b.example", publisherId: "publisher-b" });
  assert.equal(calls.length, 1); // only publisher-b's single unacked event
  assert.equal(calls[0]!.body, JSON.stringify(buildSettlementBody(evt("b1", "publisher-b"), ARC_TESTNET.chainId)));
});

test("dark scope (no secret, no global secret) is a no-op", async () => {
  const calls = captureFetch();
  const summary = await drainSettlements({ publisherId: "publisher-a" });
  assert.deepEqual(summary, { acked: 0, pending: 0 });
  assert.equal(calls.length, 0);
});

test("the settlement body carries the event's own settlement chain (per-tenant), not the fleet default", async () => {
  // A base-settled event carries chainId 8453, stamped at settle time. The drain
  // must re-send it on base — never the process-global activeNetwork() (arcTestnet
  // in this suite). This is what makes a per-tenant chain survive a re-send.
  await sink.record({ ...evt("c1", "publisher-c"), chainId: 8453 });
  const calls = captureFetch();
  await drainSettlements({ secret: "s", originUrl: "https://c.example", publisherId: "publisher-c" });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0]!.body).chainId, 8453);
});

test("an event with no stamped chain falls back to activeNetwork (single-tenant default)", async () => {
  await sink.record(evt("d1", "publisher-d")); // no chainId — the pre-B default
  const calls = captureFetch();
  await drainSettlements({ secret: "s", originUrl: "https://d.example", publisherId: "publisher-d" });
  assert.equal(JSON.parse(calls[0]!.body).chainId, ARC_TESTNET.chainId);
});
