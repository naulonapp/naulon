/**
 * SettlementDeliveryStore — durable, per-event DELIVERY state for the settlement drain.
 *
 * The settlement ledger (`naulon_events`) records that money MOVED. Whether the
 * publisher has acked our report of it is a different lifecycle entirely: mutable,
 * retried, eventually terminal. So it gets its own store, keyed by event id, and the
 * ledger stays append-only (the cloud's 0103 migration revokes update/delete on the
 * events table precisely because it records money — mutating it would break that).
 *
 * This closes two defects in the old drain:
 *
 *   1. ACK STATE WAS PROCESS-LOCAL. The JSONL outbox is correct but invisible to the
 *      database, so every sweep had to re-read the entire lifetime ledger and re-filter
 *      it locally, and a multi-instance fleet had every box redundantly re-POSTing
 *      everything. `due()` now asks the server for the work, not the whole ledger.
 *
 *   2. RETRY WAS UNBOUNDED AND INVISIBLE. A permanently-failing event got a fresh full
 *      retry ladder every sweep, forever, silently. `attempts` is now persisted,
 *      `nextAttemptAt` spaces the retries exponentially, and after
 *      SETTLEMENT_MAX_DELIVERY_ATTEMPTS the event is DEAD-LETTERED.
 *
 * DEAD-LETTERED MEANS PARKED AND VISIBLE — NEVER DROPPED. The money is still owed. A
 * dead letter stops the automatic ladder and raises its hand; an operator can revive it
 * (`revive`) and the next sweep picks it up. There is deliberately NO age cutoff:
 * silently abandoning owed money is the one outcome worse than retrying forever.
 *
 * Backends mirror the EventSink / PendingLegSink story — file (self-host, no creds,
 * the dark-by-default path) and supabase (the fleet) — selected by
 * SETTLEMENT_DELIVERY_BACKEND, plus an in-memory one for tests.
 */
import { getConfig, supabaseRest, type AttributedEvent } from "@naulon/shared";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readAll } from "./eventLog.ts";
import { isAcked, markAcked } from "./settlementOutbox.ts";

/** Mutable per-event delivery state. Absent entirely = never attempted = due now. */
export interface DeliveryState {
  eventId: string;
  /** The publisher this event is attributed to — denormalized so the due-query is
   *  index-scannable per tenant without joining the ledger. */
  publisherId?: string | undefined;
  /** epoch ms the publisher confirmed it. Set ⇒ terminal success, never re-sent. */
  ackedAt?: number | undefined;
  /** How many SWEEPS have failed on this event (not attempts within one sweep). */
  attempts: number;
  lastAttemptAt?: number | undefined;
  /** epoch ms this event becomes eligible again — the cross-sweep backoff. */
  nextAttemptAt: number;
  /** epoch ms the attempt budget ran out. Parked + surfaced; still owed, still revivable. */
  deadLetteredAt?: number | undefined;
  /** Why the last attempt failed — what an operator reads to decide what to do. */
  lastError?: string | undefined;
}

/** What `markFailed` needs to compute the next state. Injected rather than read from
 *  config inside the store so the policy is testable without touching env. */
export interface FailureInput {
  eventId: string;
  publisherId?: string | undefined;
  now: number;
  error: string;
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

/**
 * The delivery-state seam. Reads are the drain's and the operator console's; writes are
 * the drain's outcome. A backend that cannot see the ledger (memory) is seeded with it.
 */
export interface SettlementDeliveryStore {
  /**
   * The events DUE for a delivery attempt, oldest first, at most `limit`.
   *
   * DUE = no delivery row at all (never attempted), OR a row that is unacked AND not
   * dead-lettered AND whose `nextAttemptAt <= now`. The supabase backend evaluates this
   * server-side (an anti-join PostgREST cannot express in a query string, so it is a SQL
   * function); the file/memory backends filter the ledger locally.
   */
  due(input: { now: number; publisherId?: string | undefined; limit: number }): Promise<AttributedEvent[]>;
  /** True if this event is already acked — the hot path's cheap skip. */
  isAcked(eventId: string): Promise<boolean>;
  /** Terminal success. Idempotent: re-acking an acked event is a no-op. */
  markAcked(eventId: string, publisherId: string | undefined, now: number): Promise<void>;
  /** Record a failed sweep: bump `attempts`, push `nextAttemptAt` out along the backoff
   *  ladder, and dead-letter once the budget is spent. Returns the state it wrote. */
  markFailed(input: FailureInput): Promise<DeliveryState>;
  /** Dead-lettered events — the operator surface. Scoped to `publisherIds` when given
   *  (tenant isolation: a caller must never see another tenant's stuck money). */
  deadLettered(input: { publisherIds?: string[] | undefined; limit: number }): Promise<DeliveryState[]>;
  /** Clear `deadLetteredAt` and make the event due now, so the next ordinary sweep picks
   *  it up. Returns false if there was no dead-lettered row to revive (already acked,
   *  already revived, unknown id) — so the caller can report an honest no-op. */
  revive(eventId: string, now: number): Promise<boolean>;
}

/**
 * The backoff ladder. `attempts` is the count AFTER this failure, so the first failure
 * (attempts=1) waits `base`, the second `2*base`, and so on until `cap`.
 *
 * Exported because it is the policy, and the policy deserves a direct test rather than
 * being inferred from timestamps three layers up.
 */
export function backoffMs(attempts: number, baseMs: number, capMs: number): number {
  // 2 ** 30 already overflows any sane cap; clamp the exponent so a pathological
  // attempts value can't produce Infinity and poison nextAttemptAt.
  const exponent = Math.min(Math.max(attempts, 1) - 1, 30);
  return Math.min(baseMs * 2 ** exponent, capMs);
}

/** Apply one failure to a prior state (or none) → the state to persist. The whole
 *  retry/dead-letter policy in one pure function, shared by every backend. */
export function nextStateAfterFailure(prior: DeliveryState | undefined, input: FailureInput): DeliveryState {
  const attempts = (prior?.attempts ?? 0) + 1;
  const dead = attempts >= input.maxAttempts;
  return {
    eventId: input.eventId,
    publisherId: input.publisherId ?? prior?.publisherId,
    attempts,
    lastAttemptAt: input.now,
    // A dead-lettered event still carries a sane next-attempt time: reviving it only has
    // to clear the dead-letter stamp, and a revive sets the time to now anyway.
    nextAttemptAt: input.now + backoffMs(attempts, input.baseMs, input.capMs),
    deadLetteredAt: dead ? (prior?.deadLetteredAt ?? input.now) : undefined,
    lastError: input.error,
  };
}

/** Is this state due for another attempt at `now`? The single definition of DUE that the
 *  file and memory backends share (supabase evaluates the same predicate in SQL). */
function isDue(state: DeliveryState | undefined, now: number): boolean {
  if (!state) return true; // never attempted
  if (state.ackedAt !== undefined) return false;
  if (state.deadLetteredAt !== undefined) return false;
  return state.nextAttemptAt <= now;
}

// ── In-memory backend (tests) ────────────────────────────────────────────────────────

/**
 * Memory store seeded with the ledger it should treat as the universe of events. Tests
 * drive this; nothing in production selects it.
 */
export function memorySettlementDeliveryStore(events: AttributedEvent[] = []): SettlementDeliveryStore {
  const ledger = [...events];
  const states = new Map<string, DeliveryState>();
  return {
    async due({ now, publisherId, limit }) {
      return ledger
        .filter((e) => publisherId === undefined || e.publisherId === publisherId)
        .filter((e) => isDue(states.get(e.id), now))
        .sort((a, b) => a.at - b.at)
        .slice(0, limit);
    },
    async isAcked(eventId) {
      return states.get(eventId)?.ackedAt !== undefined;
    },
    async markAcked(eventId, publisherId, now) {
      const prior = states.get(eventId);
      if (prior?.ackedAt !== undefined) return; // idempotent
      states.set(eventId, {
        eventId,
        publisherId: publisherId ?? prior?.publisherId,
        attempts: prior?.attempts ?? 0,
        lastAttemptAt: now,
        nextAttemptAt: now,
        ackedAt: now,
        // An ack CLEARS a dead letter: the money got through, so the operator's
        // stuck-money list must stop showing it.
        deadLetteredAt: undefined,
        lastError: undefined,
      });
    },
    async markFailed(input) {
      const next = nextStateAfterFailure(states.get(input.eventId), input);
      states.set(input.eventId, next);
      return next;
    },
    async deadLettered({ publisherIds, limit }) {
      return [...states.values()]
        .filter((s) => s.deadLetteredAt !== undefined && s.ackedAt === undefined)
        .filter((s) => publisherIds === undefined || (s.publisherId !== undefined && publisherIds.includes(s.publisherId)))
        .sort((a, b) => (b.deadLetteredAt ?? 0) - (a.deadLetteredAt ?? 0))
        .slice(0, limit);
    },
    async revive(eventId, now) {
      const prior = states.get(eventId);
      if (!prior || prior.deadLetteredAt === undefined || prior.ackedAt !== undefined) return false;
      states.set(eventId, { ...prior, deadLetteredAt: undefined, nextAttemptAt: now });
      return true;
    },
  };
}

// ── File backend (self-host, no creds — the dark-by-default path) ────────────────────

/**
 * Append-only JSONL of DeliveryState records, last write wins on load. Same shape and
 * durability story as the outbox next to it, and the same "losing it costs a redundant
 * POST, never an earnings record" property.
 *
 * ACKS DELEGATE TO THE EXISTING OUTBOX (`settlementOutbox.ts`) rather than being
 * duplicated here. That is the reconciliation story for the file path: an outbox written
 * by the old code is read by the new code unchanged, so nothing is re-POSTed on upgrade.
 */
export function fileSettlementDeliveryStore(): SettlementDeliveryStore {
  const path = (): string => resolve(getConfig().SETTLEMENT_DELIVERY_STATE_PATH);
  let cache: Map<string, DeliveryState> | null = null;

  async function load(): Promise<Map<string, DeliveryState>> {
    if (cache) return cache;
    const map = new Map<string, DeliveryState>();
    try {
      const raw = await readFile(path(), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const state = JSON.parse(line) as DeliveryState;
        map.set(state.eventId, state); // later line wins
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    cache = map;
    return map;
  }

  async function write(state: DeliveryState): Promise<void> {
    const map = await load();
    map.set(state.eventId, state);
    const file = path();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(state) + "\n", "utf8");
  }

  return {
    async due({ now, publisherId, limit }) {
      const map = await load();
      const events = await readAll(publisherId);
      const out: AttributedEvent[] = [];
      for (const e of events) {
        if (out.length >= limit) break;
        // The outbox is the ack authority on this path (see the note above), so an event
        // acked before this store existed is correctly skipped without a state row.
        if (await isAcked(e.id)) continue;
        if (isDue(map.get(e.id), now)) out.push(e);
      }
      return out;
    },
    async isAcked(eventId) {
      return isAcked(eventId);
    },
    async markAcked(eventId, publisherId, now) {
      await markAcked(eventId); // the outbox is the durable ack record
      const map = await load();
      const prior = map.get(eventId);
      if (prior) await write({ ...prior, ackedAt: now, deadLetteredAt: undefined, lastError: undefined });
    },
    async markFailed(input) {
      const map = await load();
      const next = nextStateAfterFailure(map.get(input.eventId), input);
      await write(next);
      return next;
    },
    async deadLettered({ publisherIds, limit }) {
      const map = await load();
      const out: DeliveryState[] = [];
      for (const s of map.values()) {
        if (s.deadLetteredAt === undefined) continue;
        if (await isAcked(s.eventId)) continue;
        if (publisherIds !== undefined && (s.publisherId === undefined || !publisherIds.includes(s.publisherId))) continue;
        out.push(s);
      }
      return out.sort((a, b) => (b.deadLetteredAt ?? 0) - (a.deadLetteredAt ?? 0)).slice(0, limit);
    },
    async revive(eventId, now) {
      const map = await load();
      const prior = map.get(eventId);
      if (!prior || prior.deadLetteredAt === undefined) return false;
      if (await isAcked(eventId)) return false;
      await write({ ...prior, deadLetteredAt: undefined, nextAttemptAt: now });
      return true;
    },
  };
}

// ── Supabase backend (the fleet) ─────────────────────────────────────────────────────

/** The row shape of `naulon_settlement_delivery` (migration 0004 / cloud 0112). */
interface DeliveryRow {
  event_id: string;
  publisher: string | null;
  acked_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string;
  dead_lettered_at: string | null;
  last_error: string | null;
}

const ms = (t: string | null): number | undefined => (t === null ? undefined : Date.parse(t));
const iso = (t: number): string => new Date(t).toISOString();

function toState(row: DeliveryRow): DeliveryState {
  return {
    eventId: row.event_id,
    publisherId: row.publisher ?? undefined,
    ackedAt: ms(row.acked_at),
    attempts: row.attempts,
    lastAttemptAt: ms(row.last_attempt_at),
    nextAttemptAt: ms(row.next_attempt_at) ?? 0,
    deadLetteredAt: ms(row.dead_lettered_at),
    lastError: row.last_error ?? undefined,
  };
}

/**
 * Supabase-backed store. One row per event, keyed by `event_id`.
 *
 * `due` is a SQL FUNCTION (`naulon_settlement_due`) rather than a query string, because
 * the predicate is an ANTI-JOIN — "events with no delivery row, or whose row is unacked,
 * not dead-lettered, and past its next attempt" — which PostgREST's query grammar cannot
 * express across two tables. The function takes an explicit limit so the result can never
 * be silently clipped by `db-max-rows` (the failure mode fixed in 1b44c11).
 */
export function supabaseSettlementDeliveryStore(): SettlementDeliveryStore {
  const table = (): string => getConfig().SUPABASE_SETTLEMENT_DELIVERY_TABLE;

  /** Read one row, or undefined. */
  async function get(eventId: string): Promise<DeliveryState | undefined> {
    const rows = (await supabaseRest(
      `/rest/v1/${table()}?select=*&event_id=eq.${encodeURIComponent(eventId)}&limit=1`,
    )) as DeliveryRow[];
    const row = rows[0];
    return row === undefined ? undefined : toState(row);
  }

  /** Upsert the whole row on the event_id primary key. */
  async function upsert(state: DeliveryState): Promise<void> {
    await supabaseRest(`/rest/v1/${table()}?on_conflict=event_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([
        {
          event_id: state.eventId,
          publisher: state.publisherId ?? null,
          acked_at: state.ackedAt === undefined ? null : iso(state.ackedAt),
          attempts: state.attempts,
          last_attempt_at: state.lastAttemptAt === undefined ? null : iso(state.lastAttemptAt),
          next_attempt_at: iso(state.nextAttemptAt),
          dead_lettered_at: state.deadLetteredAt === undefined ? null : iso(state.deadLetteredAt),
          last_error: state.lastError ?? null,
        },
      ]),
    });
  }

  return {
    async due({ now, publisherId, limit }) {
      const rows = (await supabaseRest(`/rest/v1/rpc/naulon_settlement_due`, {
        method: "POST",
        body: JSON.stringify({
          p_publisher: publisherId ?? null,
          p_now: iso(now),
          p_limit: limit,
        }),
      })) as Array<{ data: AttributedEvent }>;
      return rows.map((r) => r.data);
    },
    async isAcked(eventId) {
      return (await get(eventId))?.ackedAt !== undefined;
    },
    async markAcked(eventId, publisherId, now) {
      const prior = await get(eventId);
      if (prior?.ackedAt !== undefined) return; // idempotent
      await upsert({
        eventId,
        publisherId: publisherId ?? prior?.publisherId,
        attempts: prior?.attempts ?? 0,
        lastAttemptAt: now,
        nextAttemptAt: now,
        ackedAt: now,
        deadLetteredAt: undefined, // an ack clears a dead letter — the money got through
        lastError: undefined,
      });
    },
    async markFailed(input) {
      const next = nextStateAfterFailure(await get(input.eventId), input);
      await upsert(next);
      return next;
    },
    async deadLettered({ publisherIds, limit }) {
      // Tenant isolation: an empty id list must return NOTHING, not the whole fleet. A
      // PostgREST `in.()` with no members is a syntax error, so short-circuit it here.
      if (publisherIds !== undefined && publisherIds.length === 0) return [];
      const scope =
        publisherIds === undefined
          ? ""
          : `&publisher=in.(${publisherIds.map((p) => `"${encodeURIComponent(p)}"`).join(",")})`;
      const rows = (await supabaseRest(
        `/rest/v1/${table()}?select=*&dead_lettered_at=not.is.null&acked_at=is.null` +
          `${scope}&order=dead_lettered_at.desc&limit=${limit}`,
      )) as DeliveryRow[];
      return rows.map(toState);
    },
    async revive(eventId, now) {
      // Conditional PATCH, the same compare-and-set shape as PendingLegSink.markSettled:
      // only a genuinely dead-lettered, unacked row flips, and a non-empty representation
      // means THIS call won. Two operators clicking retry cannot both report success.
      const rows = (await supabaseRest(
        `/rest/v1/${table()}?event_id=eq.${encodeURIComponent(eventId)}&dead_lettered_at=not.is.null&acked_at=is.null`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ dead_lettered_at: null, next_attempt_at: iso(now) }),
        },
      )) as unknown[];
      return rows.length > 0;
    },
  };
}

/**
 * The process-wide store the config asks for. File by default (self-host, no creds);
 * supabase when SETTLEMENT_DELIVERY_BACKEND=supabase.
 *
 * MEMOIZED for the same reason as `getPendingLegSink`: the drain and the hot-path emit
 * must share one instance or the file backend's cache would diverge from itself.
 */
let store: SettlementDeliveryStore | undefined;
export function getSettlementDeliveryStore(): SettlementDeliveryStore {
  if (!store) {
    store =
      getConfig().SETTLEMENT_DELIVERY_BACKEND === "supabase"
        ? supabaseSettlementDeliveryStore()
        : fileSettlementDeliveryStore();
  }
  return store;
}

/** Test hook — drop the memoized store (and let a test inject its own). Mirrors
 *  `resetPendingLegSink` / `resetOutboxCache`. */
export function setSettlementDeliveryStore(next: SettlementDeliveryStore | undefined): void {
  store = next;
}
