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
  /**
   * Atomically CLAIM a leg for a settle attempt, before anything is broadcast. Returns true
   * IFF this call won the claim; false if another drain holds a live claim or the leg is
   * already settled.
   *
   * Why this exists (the broadcast-before-CAS defect): the drain used to settle on-chain and
   * only then compare-and-set. A crash or a failed PATCH in between left `settled=false` for a
   * leg whose money HAD moved — so every later sweep re-broadcast it, the token contract
   * rejected the spent authorization, the leg counted `failed`, and it churned until
   * `validBefore` elapsed and then vanished. Real money moved and the ledger said it never did.
   *
   * A DB write and an on-chain broadcast can never be one atomic act, so the window cannot be
   * closed — only made explicit and recoverable. Claiming first inverts which way it fails: a
   * crash now leaves a leg visibly CLAIMED (an attempt whose outcome is unknown) instead of
   * invisibly pending, and `claimedUntil` bounds how long that lasts.
   *
   * `claimUntil` is an epoch-ms lease. When it lapses the leg becomes claimable again, so a
   * process that died mid-attempt cannot strand a leg forever.
   *
   * OPTIONAL: a sink that does not implement it is driven exactly as before (the drain
   * degrades to the old ordering rather than refusing to run) — this is an additive seam, so
   * an out-of-tree sink keeps working.
   */
  claim?(id: string, claimUntil: number, now: number): Promise<boolean>;
  /** Release a claim after an attempt that provably did NOT move money, so the leg retries on
   *  the next pass instead of waiting out its lease. Never called when the outcome is unknown. */
  release?(id: string): Promise<void>;
}

/** In-memory sink — dev + tests. The Map is the durable store for the process. */
export function memoryPendingLegSink(seed: PendingLeg[] = []): PendingLegSink {
  const legs = new Map<string, { leg: PendingLeg; settled: boolean; ref?: string; claimedUntil?: number }>();
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
    async claim(id, claimUntil, now) {
      const e = legs.get(id);
      if (!e || e.settled) return false;
      if (e.claimedUntil !== undefined && e.claimedUntil > now) return false; // a live claim elsewhere
      e.claimedUntil = claimUntil;
      return true;
    },
    async release(id) {
      const e = legs.get(id);
      if (e) delete e.claimedUntil;
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
      // Claimed-and-still-leased legs are excluded: another drain is mid-attempt on them, and
      // re-broadcasting an in-flight authorization is exactly what this design avoids. A lapsed
      // lease (or a null one) is fair game again.
      const claimable = `&or=(claimed_until.is.null,claimed_until.lt.${now})`;
      const rows = (await supabaseRest(
        `/rest/v1/${table}?select=data&settled=is.false&valid_before=gt.${now}${claimable}&order=valid_before.asc${scope}`,
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
    async claim(id, claimUntil, now) {
      // Conditional PATCH, same compare-and-set shape as markSettled: the row flips only if it is
      // unsettled AND not under a live claim. The DB decides the winner, so two drains on two
      // boxes cannot both broadcast the same authorization.
      const rows = (await supabaseRest(
        `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&settled=is.false&or=(claimed_until.is.null,claimed_until.lt.${now})`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ claimed_until: claimUntil }),
        },
      )) as unknown[];
      return rows.length > 0;
    },
    async release(id) {
      await supabaseRest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&settled=is.false`, {
        method: "PATCH",
        body: JSON.stringify({ claimed_until: null }),
      });
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
