// packages/shared/src/webhooks/jsonl-store.ts — a file-backed WebhookDeliveryStore. The durable
// self-host counterpart to MemoryWebhookDeliveryStore, and the sibling of the settlement drain's
// fileSettlementDeliveryStore: append-only JSONL, last line wins per id on replay.
//
// It exists for two reasons, and the second one is not a UI convenience:
//
//   1. DURABILITY. The gate's webhook sink held every delivery in memory, so a restart dropped
//      whatever had not been sent yet — including a settlement notification the operator is owed.
//      The same "losing it costs a redundant POST, never an earnings record" property as the
//      outbox: the ledger is the money, this is only the report of it.
//
//   2. CROSS-PROCESS VISIBILITY. The dashboard is a SEPARATE process from the gate (its own
//      `tsx src/index.ts`); the two share state only through files. An in-memory delivery log is
//      invisible to the console by construction, so the operator could never be shown whether a
//      webhook actually landed. A file is the seam the rest of this codebase already uses for
//      exactly this (EVENTS_PATH, OBSERVATIONS_PATH).
//
// The cache therefore REVALIDATES on the file's mtime+size rather than being held forever the way
// the single-writer settlement store holds its own — a stale read here would show the operator a
// delivery state the gate has already moved past.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WebhookDelivery, WebhookDeliveryStore } from "./types.ts";

export interface JsonlWebhookDeliveryStoreOptions {
  /** Absolute or relative path to the journal. Resolved once per call, so a test can repoint it. */
  path: string | (() => string);
  now?: () => number;
  /**
   * Rewrite the journal when it exceeds this many lines. A delivery is rewritten once per attempt,
   * so a busy gate accumulates superseded lines faster than it accumulates deliveries.
   */
  compactAtLines?: number;
  /** How many TERMINAL (delivered) records to keep when compacting. Unsent work is never dropped. */
  keepDelivered?: number;
}

const DEFAULT_COMPACT_AT_LINES = 5_000;
const DEFAULT_KEEP_DELIVERED = 1_000;

/** A record is safe to drop only once it is delivered. Pending/failed/exhausted is still owed. */
function isTerminal(d: WebhookDelivery): boolean {
  return d.status === "delivered";
}

export class JsonlWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly resolvePath: () => string;
  private readonly now: () => number;
  private readonly compactAtLines: number;
  private readonly keepDelivered: number;

  /** id → row, replayed from the journal. Null when the cache must be rebuilt. */
  private cache: Map<string, WebhookDelivery> | null = null;
  /** The file identity the cache was built from — mtime+size. A change means someone else wrote. */
  private stamp: string | null = null;
  /** Lines in the journal as of the last load, for the compaction trigger. */
  private lines = 0;
  /**
   * id → claim timestamp. In-memory, like MemoryWebhookDeliveryStore's: the lease guards a crashed
   * sweep WITHIN one process. Self-host runs one gate, so there is no second sweeper to fence off;
   * a cross-process lease would need a lock file, which is not worth it for a shape that has one
   * writer of attempts by construction.
   */
  private readonly claimedAt = new Map<string, number>();

  constructor(opts: JsonlWebhookDeliveryStoreOptions) {
    const p = opts.path;
    this.resolvePath = typeof p === "function" ? () => resolve(p()) : () => resolve(p);
    this.now = opts.now ?? Date.now;
    this.compactAtLines = opts.compactAtLines ?? DEFAULT_COMPACT_AT_LINES;
    this.keepDelivered = opts.keepDelivered ?? DEFAULT_KEEP_DELIVERED;
  }

  /** The file's identity, or null when it does not exist yet. */
  private async currentStamp(): Promise<string | null> {
    try {
      const s = await stat(this.resolvePath());
      return `${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Replay the journal into a map, reusing the cache while the file is byte-identical to the one it
   * was built from. A line that will not parse is SKIPPED, not thrown on: two processes appending to
   * one file can, in the worst case, interleave a partial write, and one torn line must not take
   * down the operator's whole delivery view.
   */
  private async load(): Promise<Map<string, WebhookDelivery>> {
    const stamp = await this.currentStamp();
    if (this.cache !== null && stamp === this.stamp) return this.cache;

    const map = new Map<string, WebhookDelivery>();
    let lines = 0;
    if (stamp !== null) {
      const raw = await readFile(this.resolvePath(), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        lines += 1;
        try {
          const row = JSON.parse(line) as WebhookDelivery;
          if (typeof row?.id === "string") map.set(row.id, row); // later line wins
        } catch {
          /* a torn or truncated line is skipped — see above */
        }
      }
    }
    this.cache = map;
    this.stamp = stamp;
    this.lines = lines;
    return map;
  }

  /** Append one record and drop the cache, so the next read re-reads (and sees other writers too). */
  private async append(row: WebhookDelivery): Promise<void> {
    const file = this.resolvePath();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(row) + "\n", "utf8");
    this.lines += 1;
    this.cache = null;
    this.stamp = null;
    if (this.lines > this.compactAtLines) await this.compact();
  }

  /**
   * Rewrite the journal as one line per live record. Keeps EVERY non-delivered delivery however old
   * — an unsent webhook is still owed, and silently dropping it is the one outcome worse than a big
   * file — plus the newest `keepDelivered` delivered ones for the operator's log.
   *
   * Written to a temp file and renamed, so a crash mid-compaction leaves the old journal intact
   * rather than a half-written one.
   */
  private async compact(): Promise<void> {
    const map = await this.load();
    const rows = [...map.values()];
    const keep = rows.filter((r) => !isTerminal(r));
    const delivered = rows
      .filter(isTerminal)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, this.keepDelivered);
    const out = [...keep, ...delivered].sort((a, b) => a.createdAt - b.createdAt);

    const file = this.resolvePath();
    const tmp = `${file}.compact.${process.pid}`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""), "utf8");
    await rename(tmp, file);
    this.cache = null;
    this.stamp = null;
    this.lines = out.length;
  }

  async enqueue(
    d: Omit<
      WebhookDelivery,
      "id" | "createdAt" | "status" | "attemptCount" | "lastAttemptAt" | "lastStatusCode" | "lastResponseBody" | "lastError"
    > & { id?: string },
  ): Promise<WebhookDelivery> {
    // ON CONFLICT (endpointId,eventId) DO NOTHING — the existing row, never a second one.
    const map = await this.load();
    for (const row of map.values()) {
      if (row.endpointId === d.endpointId && row.eventId === d.eventId) return { ...row };
    }
    const row: WebhookDelivery = {
      id: d.id ?? randomUUID(),
      endpointId: d.endpointId,
      eventType: d.eventType,
      eventId: d.eventId,
      host: d.host,
      payload: d.payload,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: d.nextAttemptAt,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastResponseBody: null,
      lastError: null,
      createdAt: this.now(),
    };
    await this.append(row);
    return { ...row };
  }

  async listDue(now: number, limit: number): Promise<WebhookDelivery[]> {
    const map = await this.load();
    return [...map.values()]
      .filter((r) => r.status === "pending" && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async claimDue(now: number, limit: number, leaseMs: number): Promise<WebhookDelivery[]> {
    const map = await this.load();
    const claimable = [...map.values()]
      .filter((r) => r.status === "pending" && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      .filter((r) => {
        const c = this.claimedAt.get(r.id);
        return c === undefined || c <= now - leaseMs;
      })
      .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
      .slice(0, limit);
    for (const r of claimable) this.claimedAt.set(r.id, now);
    return claimable.map((r) => ({ ...r }));
  }

  async listForEndpoint(endpointId: string, cursor: number | null, limit: number): Promise<WebhookDelivery[]> {
    const map = await this.load();
    return [...map.values()]
      .filter((r) => r.endpointId === endpointId && (cursor === null || r.createdAt < cursor))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async get(id: string): Promise<WebhookDelivery | null> {
    const row = (await this.load()).get(id);
    return row ? { ...row } : null;
  }

  async recordAttempt(
    id: string,
    patch: Partial<
      Pick<
        WebhookDelivery,
        "status" | "attemptCount" | "nextAttemptAt" | "lastAttemptAt" | "lastStatusCode" | "lastResponseBody" | "lastError"
      >
    >,
  ): Promise<void> {
    const map = await this.load();
    const row = map.get(id);
    if (!row) return;
    this.claimedAt.delete(id); // release the lease — retry timing is nextAttemptAt's job
    await this.append({ ...row, ...patch });
  }

  async deadLettered({ hosts, limit }: { hosts?: string[] | undefined; limit: number }): Promise<WebhookDelivery[]> {
    const map = await this.load();
    const hostSet = hosts === undefined ? null : new Set(hosts);
    return [...map.values()]
      .filter((r) => r.status === "exhausted")
      .filter((r) => hostSet === null || (r.host !== null && hostSet.has(r.host)))
      .sort((a, b) => (b.lastAttemptAt ?? b.createdAt) - (a.lastAttemptAt ?? a.createdAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async revive(id: string, now: number): Promise<boolean> {
    const map = await this.load();
    const row = map.get(id);
    if (!row || row.status !== "exhausted") return false;
    this.claimedAt.delete(id);
    await this.append({ ...row, status: "pending", nextAttemptAt: now });
    return true;
  }

  /** Every delivery in the journal, newest first — the console's read plane. */
  async listAll(limit: number): Promise<WebhookDelivery[]> {
    const map = await this.load();
    return [...map.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
