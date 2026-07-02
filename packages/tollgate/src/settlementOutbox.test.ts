/**
 * The settlement outbox is the durable marker that makes at-least-once delivery
 * crash-safe: an ack must survive a process restart (re-read from disk), or the
 * drain would re-POST forever. These tests pin that persistence + idempotency.
 *
 * Set the outbox path before any getConfig() call (it caches on first read, and
 * test bodies run after this top-level line). NODE_ENV=test skips dotenv, so the
 * env we set here is the one config sees.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "naulon-outbox-"));
process.env.SETTLEMENT_OUTBOX_PATH = join(dir, "outbox.jsonl");

const { isAcked, markAcked, resetOutboxCache } = await import("./settlementOutbox.ts");

test("an unmarked id is not acked; a marked one is", async () => {
  assert.equal(await isAcked("evt-unknown"), false);
  await markAcked("evt-1");
  assert.equal(await isAcked("evt-1"), true);
});

test("an ack survives a process restart (re-read from disk)", async () => {
  await markAcked("evt-persist");
  resetOutboxCache(); // simulate a fresh process — drop the in-memory set
  assert.equal(await isAcked("evt-persist"), true);
});

test("marking the same id twice appends only one line (idempotent)", async () => {
  await markAcked("evt-dup");
  await markAcked("evt-dup");
  const raw = await readFile(process.env.SETTLEMENT_OUTBOX_PATH!, "utf8");
  const lines = raw.split("\n").filter((l) => l.includes("evt-dup"));
  assert.equal(lines.length, 1);
});
