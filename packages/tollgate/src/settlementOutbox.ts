/**
 * Durable record of which settled events the publisher has already acked, so the
 * background drain (settlementSink.ts) only re-sends what's actually unconfirmed.
 *
 * Append-only JSONL of acked event ids, mirroring the event ledger's file
 * shape. It is an OPTIMIZATION, never a correctness dependency: if this file is
 * lost the drain just re-POSTs already-acked events, and the publisher dedupes them on
 * eventId. That property is what makes at-least-once safe — losing local state
 * can only cost a redundant request, never an author's earnings record.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@naulon/shared";

const file = (): string => resolve(getConfig().SETTLEMENT_OUTBOX_PATH);

let acked: Set<string> | null = null;

/** Load the acked-id set once (lazily). Missing file → empty set. */
async function load(): Promise<Set<string>> {
  if (acked) return acked;
  try {
    const raw = await readFile(file(), "utf8");
    acked = new Set(
      raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => (JSON.parse(l) as { id: string }).id),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") acked = new Set();
    else throw err;
  }
  return acked;
}

/** True if IA has confirmed this event id. */
export async function isAcked(id: string): Promise<boolean> {
  return (await load()).has(id);
}

/** Mark an event acked: in-memory + appended to disk. Idempotent. */
export async function markAcked(id: string): Promise<void> {
  const set = await load();
  if (set.has(id)) return;
  set.add(id);
  const path = file();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ id }) + "\n", "utf8");
}

/** Test hook: drop the in-memory cache so the next call re-reads from disk. */
export function resetOutboxCache(): void {
  acked = null;
}
