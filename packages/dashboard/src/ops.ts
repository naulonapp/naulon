/**
 * Turn the gate's raw observation log into the operator's ops summary: the
 * traffic verdicts (who was served free, denied, paid, failed), the earnings it
 * captured vs the earnings it missed, and the agent-identity split (verified via
 * Web Bot Auth vs unsigned vs an outright masquerade). This is what tells a
 * self-hoster their proxy is actually working — distinct from the earnings
 * ledger, which only sees settled money.
 */
import { OBSERVATION_VERDICTS, effectiveVerdict } from "@naulon/shared";
import type { ObservationEvent, ObservationVerdict } from "@naulon/shared";
import { agentKeyOf, outcomeOf, type Outcome } from "./traffic.ts";

/** From shared, never re-typed — see the note on `OBSERVATION_VERDICTS`. */
const VERDICTS: readonly ObservationVerdict[] = OBSERVATION_VERDICTS;

export interface OpsSummary {
  /** Window the traffic figures cover (ms). */
  windowMs: number;
  /** epoch ms the summary was computed at. */
  at: number;
  /** Observations inside the window. */
  total: number;
  byVerdict: Record<ObservationVerdict, number>;
  /** Agent traffic split by identity assurance. */
  agents: { total: number; verified: number; unverified: number; masquerade: number };
  /** Requests the classifier called human (served free). */
  humans: number;
  /** USDC actually captured (sum of `paid` prices). */
  earnings: number;
  /** USDC left on the table (sum of `denied` + `payment-failed` prices). */
  earningsMissed: number;
  /**
   * Reads served while the publisher was observing. `atPrice` is an estimate (what those reads
   * would cost at the publisher's price), never earnings. `signalledPayers` counts only reads
   * whose crawler stated a budget covering the price or presented a payment.
   */
  demand: { reads: number; atPrice: number; signalledPayers: number };
  /** Newest-first, capped — the live request feed. */
  recent: ObservationEvent[];
  /**
   * Newest-first agent requests only, each with the display name the Requests page uses. People
   * read free and outnumber agents, so a mixed feed on a real site is a column of "human".
   */
  recentAgents: Array<ObservationEvent & { agent: string }>;
  /**
   * Agent requests over the window in equal buckets, split by the Requests page's four
   * outcomes. Oldest bucket first; `start` is the first bucket's left edge.
   */
  series: { start: number; stepMs: number; buckets: Record<Outcome, number>[] };
  /**
   * What the SETTLEMENT ledger recorded in this same window — a different plane, read
   * from the event sink rather than the observation log.
   *
   * It is here so the overview can tell "nothing happened" apart from "nothing was
   * recorded". Those two look identical in `byVerdict` and mean opposite things: with
   * `OBSERVATIONS_BACKEND` switched on mid-life, every crossing that settled before the
   * switch is in the ledger and in no observation — so the counters honestly summed to
   * zero while the Ledger page showed real money for the same hours.
   */
  settled: { crossings: number; usdc: number };
}

const zeroVerdicts = (): Record<ObservationVerdict, number> =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<ObservationVerdict, number>;

/** The traffic windows the console offers, newest-narrowest first. */
export const OPS_WINDOWS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

/** Map a window key from the console to its span in ms; unknown → 24h default. */
export function windowMsFromKey(key: string | undefined): number {
  return (key && OPS_WINDOWS[key]) || OPS_WINDOWS["24h"]!;
}

/** Bucket width per window: about two dozen columns whichever window is open. */
export function seriesStepMs(windowMs: number): number {
  if (windowMs <= 3_600_000) return 5 * 60_000;
  if (windowMs <= 24 * 3_600_000) return 3_600_000;
  return 6 * 3_600_000;
}

function seriesOf(agents: readonly ObservationEvent[], nowMs: number, windowMs: number): OpsSummary["series"] {
  const stepMs = seriesStepMs(windowMs);
  const count = Math.ceil(windowMs / stepMs);
  // Right-aligned on the bucket that holds `now`, so the last column is the current one.
  const start = (Math.floor(nowMs / stepMs) - count + 1) * stepMs;
  const buckets = Array.from({ length: count }, () => ({ paid: 0, left: 0, free: 0, refused: 0 }));
  for (const o of agents) {
    const i = Math.floor((o.at - start) / stepMs);
    if (i >= 0 && i < count) buckets[i]![outcomeOf(effectiveVerdict(o))] += 1;
  }
  return { start, stepMs, buckets };
}

export function summarizeOps(
  observations: ObservationEvent[],
  nowMs: number,
  windowMs = 24 * 3_600_000,
  recentLimit = 20,
  /**
   * Settled events (the other plane) — same list the Ledger page renders. Both fields are
   * REQUIRED, so a rename in `AttributedEvent` fails the build here rather than silently
   * filtering every row out and reporting a settlement plane that is always empty.
   */
  settledEvents: readonly { at: number; amount: number }[] = [],
): OpsSummary {
  const cutoff = nowMs - windowMs;
  const inWindow = observations.filter((o) => o.at >= cutoff);

  const byVerdict = zeroVerdicts();
  const agents = { total: 0, verified: 0, unverified: 0, masquerade: 0 };
  let humans = 0;
  let earnings = 0;
  let earningsMissed = 0;
  const demand = { reads: 0, atPrice: 0, signalledPayers: 0 };

  for (const o of inWindow) {
    if (o.verdict in byVerdict) byVerdict[o.verdict] += 1;

    if (o.classifiedAs === "agent") {
      agents.total += 1;
      if (o.verified) agents.verified += 1;
      else if (o.sigInvalid) agents.masquerade += 1;
      else agents.unverified += 1;
    } else {
      humans += 1;
    }

    if (o.verdict === "paid") earnings += o.price ?? 0;
    if (o.observeOnly) {
      // Nothing was asked for, so nothing was missed: this is demand, reported apart.
      demand.reads += 1;
      demand.atPrice += o.price ?? 0;
      if (o.crawlerBudget === "within" || o.paymentPresented) demand.signalledPayers += 1;
    } else if (o.verdict === "denied" || o.verdict === "payment-failed") {
      earningsMissed += o.price ?? 0;
    }
  }

  const newest = [...inWindow].sort((a, b) => b.at - a.at);
  const recent = newest.slice(0, recentLimit);
  const agentRows = newest.filter((o) => o.classifiedAs === "agent");
  const recentAgents = agentRows.slice(0, recentLimit).map((o) => ({ ...o, agent: agentKeyOf(o) }));

  // The settlement plane over the SAME window. An event with no `at` cannot be placed in
  // a window, so it is left out rather than counted into whichever window is being asked
  // for — an undated event is not evidence about these hours.
  const settledInWindow = settledEvents.filter((e) => typeof e.at === "number" && e.at >= cutoff);

  return {
    windowMs,
    at: nowMs,
    total: inWindow.length,
    byVerdict,
    agents,
    humans,
    earnings,
    earningsMissed,
    demand,
    recent,
    recentAgents,
    series: seriesOf(agentRows, nowMs, windowMs),
    settled: {
      crossings: settledInWindow.length,
      usdc: settledInWindow.reduce((sum, e) => sum + e.amount, 0),
    },
  };
}
