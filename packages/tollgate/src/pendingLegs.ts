/**
 * PendingLegSink — durable store for buyer-authorized EXTRA settlement legs awaiting
 * a deferred on-chain settle (the "author-sync-rest-deferred" model).
 *
 * The author (primary) leg settles synchronously at the gate and gates content, exactly
 * as before. Every ADDITIONAL leg (a publisher-declared `extraLegs` entry — an operator
 * fee, a co-author, a community cut) is VERIFIED at the gate but its settlement is
 * DEFERRED: the buyer's signed EIP-3009 authorization is recorded here and a later
 * `drainPendingLegs` pass settles it on-chain, batched, within its `validBefore` window.
 *
 * Why a sink and not inline settle (the O5/O1 close):
 *   - No partial-failure window — only the author leg is synchronous, so no leg can fail
 *     "after the author was paid". A deferred leg simply retries on the next drain pass.
 *   - Idempotent by construction — `record` is keyed on the leg's authorization id, and
 *     `markSettled` is an atomic compare-and-set (settle exactly once across concurrent
 *     drains / buyer retries). That IS the per-leg replay guard (O1).
 *   - Custody-free is untouched — each persisted leg is still a DIRECT buyer→payTo
 *     EIP-3009 transfer; the gate stores a signature, never funds, and is never a `to`.
 *
 * A deliberate sibling of `EventSink`/`ObservationSink` — same backend story (memory for
 * dev/tests, supabase for the fleet), env-selected, callers use `getPendingLegSink()`.
 */
import { getConfig, supabaseRest } from "@naulon/shared";
import type { PaymentRequirements } from "@naulon/enforce";

/** One buyer-authorized extra leg awaiting settlement. The `payload` is the buyer's
 *  signed payment for THIS leg — what the drain hands to the facilitator. */
export interface PendingLeg {
  /** Unique authorization id — the EIP-3009 nonce of this leg. The idempotency key AND
   *  the on-chain replay key: a buyer retry of the same quote re-records the same id (a
   *  no-op), and `markSettled` settles it exactly once. */
  id: string;
  /** The publisher this leg is attributed to (`PublisherConfig.id`), for a scoped drain.
   *  Optional like `AttributedEvent.publisherId`; null for single-tenant. */
  publisherId?: string;
  /** Opaque ledger label ("operator" | "coauthor" | …) — no protocol meaning. */
  role: string;
  /** Direct buyer→payTo recipient (custody-free: never a naulon-held wallet). */
  payTo: string;
  /** Atomic micro-USDC, integer string. */
  amount: string;
  /** The buyer's signed payment payload for this leg (what the drain settles). */
  payload: unknown;
  /** The x402 requirements this leg settles against (amount/payTo/network/extra). */
  requirements: PaymentRequirements;
  /** epoch ms the authorization expires — the drain MUST settle before this or the leg
   *  is lost (the buyer is never charged for an expired authorization). */
  validBefore: number;
  /** epoch ms recorded. */
  at: number;
}

/** Where buyer-authorized extra legs are written and drained. Mirrors `EventSink`'s seam
 *  shape; reads are the drain's, writes are the gate's. */
export interface PendingLegSink {
  /** Record a buyer-authorized leg. Idempotent on `leg.id` — a retried write is a no-op,
   *  so a buyer re-presenting the same quote never duplicates a leg. */
  record(leg: PendingLeg): Promise<void>;
  /** Unsettled legs still inside their validity window (`validBefore > now`), oldest
   *  first — the set a drain pass settles. Optional `publisherId` scopes to one publisher. */
  pending(now: number, publisherId?: string): Promise<PendingLeg[]>;
  /** Atomically mark a leg settled. Returns true IFF THIS call won the transition
   *  (unsettled → settled); false if it was already settled — the compare-and-set that
   *  makes settle exactly-once across concurrent drains (O1). */
  markSettled(id: string, settlementRef: string): Promise<boolean>;
}

/** In-memory sink — dev + tests. The Map is the durable store for the process. */
export function memoryPendingLegSink(seed: PendingLeg[] = []): PendingLegSink {
  const legs = new Map<string, { leg: PendingLeg; settled: boolean; ref?: string }>();
  for (const l of seed) legs.set(l.id, { leg: l, settled: false });
  return {
    async record(leg) {
      if (!legs.has(leg.id)) legs.set(leg.id, { leg, settled: false }); // idempotent on id
    },
    async pending(now, publisherId) {
      return [...legs.values()]
        .filter((e) => !e.settled && e.leg.validBefore > now)
        .filter((e) => publisherId === undefined || e.leg.publisherId === publisherId)
        .map((e) => e.leg)
        .sort((a, b) => a.at - b.at);
    },
    async markSettled(id, settlementRef) {
      const e = legs.get(id);
      if (!e || e.settled) return false; // lost the race / unknown → not us
      e.settled = true;
      e.ref = settlementRef;
      return true;
    },
  };
}

/**
 * Supabase-backed sink. One row per leg: `id` (primary key → idempotent record), the
 * filter columns (`publisher`, `valid_before`, `settled`), and the whole `PendingLeg` as
 * jsonb `data` (so the drain settles the exact buyer payload the gate stored). The
 * `markSettled` PATCH filters on `settled=eq.false`, so the DB itself decides the winner
 * of a concurrent settle — atomic, race-safe across instances.
 */
export function supabasePendingLegSink(): PendingLegSink {
  const table = getConfig().SUPABASE_PENDING_LEGS_TABLE;
  return {
    async record(leg) {
      await supabaseRest(`/rest/v1/${table}?on_conflict=id`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify([
          {
            id: leg.id,
            publisher: leg.publisherId ?? null,
            valid_before: leg.validBefore,
            settled: false,
            data: leg,
          },
        ]),
      });
    },
    async pending(now, publisherId) {
      const scope = publisherId === undefined ? "" : `&publisher=eq.${encodeURIComponent(publisherId)}`;
      const rows = (await supabaseRest(
        `/rest/v1/${table}?select=data&settled=is.false&valid_before=gt.${now}&order=valid_before.asc${scope}`,
      )) as Array<{ data: PendingLeg }>;
      return rows.map((r) => r.data);
    },
    async markSettled(id, settlementRef) {
      // Conditional PATCH: only an unsettled row flips. return=representation → a non-empty
      // response means THIS call made the transition (won); [] means already settled.
      const rows = (await supabaseRest(
        `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&settled=is.false`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ settled: true, settlement_ref: settlementRef }),
        },
      )) as unknown[];
      return rows.length > 0;
    },
  };
}

/**
 * The process-wide sink the config asks for. Memory by default (dev/tests, no creds);
 * Supabase when PENDING_LEGS_BACKEND=supabase (the fleet's deferred-settle store).
 *
 * MEMOIZED — the gate's record path (`deferExtraLegs`) and the drain (`drainPendingLegs`)
 * MUST share one instance, or the memory backend's Map wouldn't be the same store. (The
 * supabase backend is stateless over a shared DB, but memoizing it is harmless.) Mirrors
 * the nonce store's module-singleton.
 */
let sink: PendingLegSink | undefined;
export function getPendingLegSink(): PendingLegSink {
  if (!sink) {
    sink = getConfig().PENDING_LEGS_BACKEND === "supabase" ? supabasePendingLegSink() : memoryPendingLegSink();
  }
  return sink;
}

/** Test hook — drop the memoized sink so the next `getPendingLegSink()` builds a fresh one,
 *  isolating pending-leg state between tests. Mirrors `resetOutboxCache`. */
export function resetPendingLegSink(): void {
  sink = undefined;
}
