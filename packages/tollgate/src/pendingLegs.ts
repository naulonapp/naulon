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
import { getConfig, readAllPaged, supabaseRest } from "@naulon/shared";
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
  /**
   * Every unsettled leg still inside its validity window — INCLUDING ones a drain currently holds a
   * claim on. The question "what is still owed", as distinct from `pending`'s "what may I broadcast
   * right now".
   *
   * The distinction is not academic, and getting it wrong silently re-opens the hole
   * {@link outstandingLegMicro} exists to close. `pending` excludes a claimed leg because another
   * drain is mid-attempt and re-broadcasting a live authorization is the thing that design avoids.
   * But a claim moves no money: `drainPendingLegs` claims BEFORE it broadcasts, and on a failed or
   * unknown-outcome attempt it deliberately does NOT release, so a leg stays claimed — and
   * therefore invisible to `pending` — for a full lease while its money is still entirely present
   * in the buyer's balance. A funding guard reading `pending` would let the buyer spend it.
   *
   * OPTIONAL only so an out-of-tree sink keeps compiling. `outstandingLegMicro` REFUSES rather than
   * falling back to `pending` when it is absent: a silent under-count here is money, and the
   * fallback would be the defect wearing the shape of a graceful degradation.
   */
  outstanding?(now: number): Promise<PendingLeg[]>;
  /** Release a claim after an attempt that provably did NOT move money, so the leg retries on
   *  the next pass instead of waiting out its lease. Never called when the outcome is unknown. */
  release?(id: string): Promise<void>;
}

/** In-memory sink — dev + tests. The Map is the durable store for the process. */
/** Loud-failure ceiling for one `pending()` read. A drain queue this deep is an operational
 *  problem or a server ignoring `offset`; either way a silent prefix is the worse answer. */
const MAX_PENDING_LEGS = 100_000;

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
        // Claimed-and-still-leased legs are excluded, matching the production sink's SQL filter.
        // They diverged: this one ignored `claimedUntil`, so a test could pass against a state the
        // supabase sink answers differently — which is how a guard built on `pending` looked correct
        // in every test and would have been wrong in prod (see `outstanding`).
        .filter((e) => e.claimedUntil === undefined || e.claimedUntil < now)
        .filter((e) => publisherId === undefined || e.leg.publisherId === publisherId)
        .map((e) => e.leg)
        .sort((a, b) => a.at - b.at);
    },
    async outstanding(now) {
      // No claim filter — see the interface note. A claim is an attempt, not a settlement.
      return [...legs.values()]
        .filter((e) => !e.settled && e.leg.validBefore > now)
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
      // PAGED: unbounded, PostgREST clips at `db-max-rows` and answers 200, so past the cap the
      // drain would never see the remaining legs — money that stays unsettled with nothing
      // reporting it. `valid_before,id` is a total order (expiries tie).
      const rows = await readAllPaged<{ data: PendingLeg }>({
        page: (limit, offset) =>
          supabaseRest(
            `/rest/v1/${table}?select=data&settled=is.false&valid_before=gt.${now}${claimable}` +
              `&order=valid_before.asc,id.asc${scope}&limit=${limit}&offset=${offset}`,
          ) as Promise<Array<{ data: PendingLeg }>>,
        maxRows: MAX_PENDING_LEGS,
        what: "pendingLegs.pending",
        because: "The settlement drain rides this read; a prefix would leave legs unsettled silently.",
      });
      return rows.map((r) => r.data);
    },
    async outstanding(now) {
      // Deliberately WITHOUT the `claimable` filter `pending` applies — a claim is a drain holding
      // a broadcast lease, not money that has moved. See the interface note.
      const rows = await readAllPaged<{ data: PendingLeg }>({
        page: (limit, offset) =>
          supabaseRest(
            `/rest/v1/${table}?select=data&settled=is.false&valid_before=gt.${now}` +
              `&order=valid_before.asc,id.asc&limit=${limit}&offset=${offset}`,
          ) as Promise<Array<{ data: PendingLeg }>>,
        maxRows: MAX_PENDING_LEGS,
        what: "pendingLegs.outstanding",
        because: "A funding guard rides this read; a silent prefix would under-report what a buyer owes and let them spend it.",
      });
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

/**
 * The buyer whose balance a pending leg will be burned from — `authorization.from` inside the
 * signed payload.
 *
 * Read out of the payload rather than stored beside it, because the payload is the thing that is
 * actually settled: a separate column could disagree with it, and the column would be the one that
 * is wrong. Returns null for a shape this does not recognise, and every caller must treat null as
 * "cannot attribute" rather than as "nobody" — see {@link outstandingLegMicro}.
 */
export function legPayer(leg: PendingLeg): string | null {
  const p = leg.payload as { payload?: { authorization?: { from?: unknown } } } | undefined;
  const from = p?.payload?.authorization?.from;
  return typeof from === "string" && from.length > 0 ? from.toLowerCase() : null;
}

/**
 * HOW MUCH OF A BUYER'S BALANCE IS ALREADY SPOKEN FOR — the total of every leg they have
 * authorized that is verified, unsettled, and still inside its validity window.
 *
 * ## Why this exists
 *
 * The author leg of a toll settles synchronously and its money leaves the buyer's Gateway balance
 * immediately. Every OTHER leg — the operator fee, a co-author cut — is verified and DEFERRED to
 * `drainPendingLegs`, so its money is still sitting in `available` while already being owed.
 *
 * A funding guard that reads `available` and compares it against the payment in front of it
 * therefore lets a buyer spend money the drain needs. Per toll the balance falls by the author leg
 * alone while the buyer's allowance falls by the whole toll, so a buyer whose allowance outlasts
 * their balance empties it — and the drain then has nothing to burn. The legs retry until
 * `validBefore` and are then gone: the payee is never paid, and the buyer keeps the USDC they
 * authorized away.
 *
 * So the guard has to be able to ask this question, and the answer has to come from the sink the
 * drain itself reads — not from a second tally that could drift out of step with it. A leg the
 * drain settles disappears from here on the next read, with no bookkeeping to reconcile.
 *
 * UNATTRIBUTABLE LEGS COUNT. A pending leg whose payer cannot be read ({@link legPayer} → null) is
 * added to every buyer's total rather than dropped. It is money owed by SOMEBODY, and the failure
 * this guards is spending a balance that is already promised — so an unreadable leg must make the
 * guard stricter, never looser. There is no shape today that produces one; this is what happens if
 * one ever appears.
 *
 * Scans every publisher's legs, because a buyer spends across the whole fleet from one balance.
 */
export async function outstandingLegMicro(
  payer: string,
  now: number = Date.now(),
  opts: {
    /** The sink to read. Defaults to the process's own — a parameter so this is testable against a
     *  memory sink without a test-only setter on the memoized singleton. */
    sink?: Pick<PendingLegSink, "outstanding">;
    /**
     * Count only legs settling on THIS network (`requirements.network`, CAIP-2).
     *
     * A Gateway balance is per (depositor, domain): the figure a guard subtracts this from is one
     * chain's `available`. Summing every chain's legs against it refuses a buyer whose money is on
     * the chain being paid because of a leg owed on a different one — fail-closed, but a permanent
     * dead end, and a refusal naming a pot that is not the one in question. Omit to count all.
     */
    network?: string;
    /**
     * Legs to EXCLUDE by id (the EIP-3009 nonce) — the ones the caller is itself about to sign.
     *
     * A buyer re-presenting an identical authorization is a replay the reserve is built to absorb
     * (`reserveSpend` → `replayed`, re-signing reproduces bytes they already hold), and that path
     * needs no new money. Without this exclusion the guard counts the retry's own already-recorded
     * legs against it and refuses a payment that has already happened, telling the buyer to add
     * funds for nothing. A genuine re-sign mints new nonces, does not match, and is still counted —
     * correctly, because it really is a second payment.
     */
    exclude?: Iterable<string>;
  } = {},
): Promise<number> {
  const sink = opts.sink ?? getPendingLegSink();
  if (typeof sink.outstanding !== "function") {
    // REFUSE rather than fall back to `pending`. That fallback would silently hide every claimed
    // leg and re-open the exact hole this function closes — a graceful degradation that loses money
    // is not graceful. The caller's guard turns this throw into a retryable refusal.
    throw new Error("pendingLegSink cannot answer what is outstanding — it implements no outstanding()");
  }
  const want = payer.toLowerCase();
  const skip = new Set(opts.exclude ?? []);
  const legs = await sink.outstanding(now);
  let total = 0;
  for (const leg of legs) {
    if (skip.has(leg.id)) continue;
    const who = legPayer(leg);
    if (who !== null && who !== want) continue;
    if (opts.network !== undefined && leg.requirements?.network !== undefined && leg.requirements.network !== opts.network) continue;
    const amount = Number(leg.amount);
    // A leg whose amount will not parse is the same class as an unattributable one: it is owed, and
    // the safe direction is to refuse rather than to under-count. `MAX_SAFE_INTEGER` is not a
    // number anyone can spend past, which is the intended effect.
    total += Number.isSafeInteger(amount) && amount >= 0 ? amount : Number.MAX_SAFE_INTEGER;
  }
  return total;
}
