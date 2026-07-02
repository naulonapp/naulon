/**
 * Scoped ledger reads: `readAll(publisherId)` must return only that publisher's
 * events, and an unscoped read must return every event (including untagged ones).
 * The optional scope is the embedding seam a downstream resolver-based deploy uses
 * to drain one publisher in isolation; a leak here would mis-attribute earnings.
 *
 * Set EVENTS_PATH before any getConfig() call (it caches on first read).
 * NODE_ENV=test skips dotenv, so the env set here is what config sees.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsonlSink, memorySink } from "./eventsink.ts";
import type { AttributedEvent, Usdc, WalletAddress } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "naulon-eventsink-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");

const PAYER = "0x3333333333333333333333333333333333333333" as WalletAddress;

function evt(id: string, publisherId?: string): AttributedEvent {
  return {
    id,
    publisherId,
    slug: "on-stillness",
    kind: "read",
    amount: 1000 as Usdc,
    payees: [],
    payerAddress: PAYER,
    settlementRef: "0xfeed",
    at: 1_700_000_000_000,
  };
}

const seed = [evt("a1", "publisher-a"), evt("b1", "publisher-b"), evt("a2", "publisher-a"), evt("legacy")];

test("memorySink: readAll() returns everything; readAll(publisher) filters", async () => {
  const sink = memorySink(seed);
  assert.equal((await sink.readAll()).length, 4);
  assert.deepEqual((await sink.readAll("publisher-a")).map((e) => e.id), ["a1", "a2"]);
  assert.deepEqual((await sink.readAll("publisher-b")).map((e) => e.id), ["b1"]);
});

test("memorySink: an untagged (single-tenant) event matches no publisher scope", async () => {
  const sink = memorySink(seed);
  assert.deepEqual((await sink.readAll("publisher-a")).map((e) => e.id).includes("legacy"), false);
  // ...but the unscoped read still returns it — OSS single-tenant is unaffected.
  assert.equal((await sink.readAll()).some((e) => e.id === "legacy"), true);
});

test("jsonlSink: written publisher tags survive a round-trip and scope reads", async () => {
  const sink = jsonlSink();
  for (const e of seed) await sink.record(e);
  assert.equal((await sink.readAll()).length, 4);
  assert.deepEqual((await sink.readAll("publisher-a")).map((e) => e.id), ["a1", "a2"]);
});
