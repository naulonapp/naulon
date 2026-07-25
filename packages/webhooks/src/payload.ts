// src/webhooks/payload.ts — the enriched `settlement.completed` body builder (Track C Phase 3).
//
// Two profiles, chosen per endpoint (see `naulon_webhook_endpoints.payload_profile`):
//   summary  — the ORIGINAL coarse body `{ tenant, acked, pending }`, byte-identical (and so
//              signature-identical) to what shipped before this phase. The safe default: every
//              existing endpoint keeps its exact body.
//   detailed — a rich window rollup: gross µUSDC + per-leg breakdown + on-chain refs.
//
// The builder is PURE — it shapes already-gathered `SettlementFacts` (the cron emit site reads the
// events + operator ledger, per the Task-12 spike). Nothing here does IO, so it is fully unit-tested.
//
// Honesty rules baked in (Task-12 spike, "no field ships unconfirmed"):
//   - Author legs come from the settled events' `payees`, split with the same dust-free `splitMicro`
//     the on-chain settlement + statements use, so `Σ author legs === Σ event gross` exactly.
//   - The operator fee is ADDITIVE (the custody-free guarantee: a separate buyer→operator transfer,
//     never a skim from an author's cut), so including it never double-counts the author gross.
//   - Co-author *deferred* legs are OMITTED (v1): they may overlap `payees`, and we won't ship a
//     figure we can't prove non-double-counting. Not faked, not null-stuffed — just absent.
//   - `txUrl` is OMITTED: the payload ships the on-chain `settlementRef`; the delivery-log inspector
//     derives the explorer link with the portal's existing chain-aware map (reuse, don't re-derive).

import { splitMicro, type AuthorShare } from "@naulon/shared";
import { microToUsdc } from "./money.ts";
import type { PayloadProfile } from "./types.ts";

/** One settled event in the just-drained window, as the cron emit site reads it from the EventSink. */
export interface SettlementEventFact {
  slug: string;
  kind: "read" | "citation";
  /** Integer µUSDC — `round(event.amount * 1e6)`; the money source of truth (never a float). */
  amountMicro: number;
  /** The gateway settlement / batch reference the gate stamped on this event. */
  settlementRef: string;
  payees: AuthorShare[];
}

/** One settled operator-fee leg for the window (from the deferred-leg ledger). Additive by the
 *  custody-free guarantee — a separate buyer→operator transfer, so it never overlaps `payees`. */
export interface SettlementOperatorLegFact {
  payTo: string;
  microUsdc: number;
  settled: boolean;
  settlementRef: string | null;
}

/** Everything the cron emit site gathers for a `(publisher, window)` settlement. */
export interface SettlementFacts {
  tenant: string;
  host: string | null;
  /** Drain summary counts — the meaning is unchanged from the summary body. */
  acked: number;
  pending: number;
  /** The coalescing/dedup window this delivery covers. `toMs` = emit time, `spanMs` = bucket width. */
  window: { toMs: number; spanMs: number };
  events: SettlementEventFact[];
  operatorLegs: SettlementOperatorLegFact[];
}

export interface SettlementLegView {
  role: "author" | "operator";
  payTo: string;
  microUsdc: number;
  settled: boolean;
  /** On-chain ref, or null when it can't be attributed to a single settlement (never faked). */
  settlementRef: string | null;
}

export interface DetailedSettlementPayload {
  tenant: string;
  host: string | null;
  window: { toMs: number; spanMs: number };
  citations: { settled: number; pending: number };
  gross: { microUsdc: number; usdc: string };
  legs: SettlementLegView[];
  settlementRefs: string[];
}

/** Aggregate the settled events' author payees into one leg per wallet (biggest-owed first),
 *  splitting each event's gross with `splitMicro` so the per-author cuts reconcile to the gross. */
function computeAuthorLegs(events: SettlementEventFact[]): SettlementLegView[] {
  const byWallet = new Map<string, { micro: number; refs: Set<string> }>();
  for (const e of events) {
    for (const alloc of splitMicro(e.amountMicro, e.payees)) {
      const cur = byWallet.get(alloc.wallet) ?? { micro: 0, refs: new Set<string>() };
      cur.micro += alloc.micro;
      if (e.settlementRef) cur.refs.add(e.settlementRef);
      byWallet.set(alloc.wallet, cur);
    }
  }
  const legs: SettlementLegView[] = [];
  for (const [wallet, v] of byWallet) {
    const only = v.refs.size === 1 ? [...v.refs][0] ?? null : null;
    legs.push({ role: "author", payTo: wallet, microUsdc: v.micro, settled: true, settlementRef: only });
  }
  legs.sort((a, b) => b.microUsdc - a.microUsdc);
  return legs;
}

/**
 * Build the webhook `settlement.completed` body for the endpoint's profile.
 * `summary` is byte-identical to the legacy body (so existing signatures never break).
 */
export function buildSettlementPayload(profile: PayloadProfile, facts: SettlementFacts): Record<string, unknown> {
  if (profile === "summary") {
    return { tenant: facts.tenant, acked: facts.acked, pending: facts.pending };
  }

  const authorLegs = computeAuthorLegs(facts.events);
  const operatorLegs: SettlementLegView[] = facts.operatorLegs.map((l) => ({
    role: "operator",
    payTo: l.payTo,
    microUsdc: l.microUsdc,
    settled: l.settled,
    settlementRef: l.settlementRef,
  }));
  const legs = [...authorLegs, ...operatorLegs];
  const grossMicro = legs.reduce((sum, l) => sum + l.microUsdc, 0);

  const refs = [
    ...facts.events.map((e) => e.settlementRef),
    ...facts.operatorLegs.map((l) => l.settlementRef),
  ].filter((r): r is string => typeof r === "string" && r.length > 0);
  const settlementRefs = [...new Set(refs)];

  const payload: DetailedSettlementPayload = {
    tenant: facts.tenant,
    host: facts.host,
    window: facts.window,
    citations: { settled: facts.acked, pending: facts.pending },
    gross: { microUsdc: grossMicro, usdc: microToUsdc(grossMicro) },
    legs,
    settlementRefs,
  };
  return payload as unknown as Record<string, unknown>;
}
