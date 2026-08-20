/**
 * Turn the gate's raw observation log into the operator's ops summary: the
 * traffic verdicts (who was served free, denied, paid, failed), the earnings it
 * captured vs the earnings it missed, and the agent-identity split (verified via
 * Web Bot Auth vs unsigned vs an outright masquerade). This is what tells a
 * self-hoster their proxy is actually working — distinct from the earnings
 * ledger, which only sees settled money.
 */
import { OBSERVATION_VERDICTS } from "@naulon/shared";
import type { ObservationEvent, ObservationVerdict } from "@naulon/shared";

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
  /** Newest-first, capped — the live request feed. */
  recent: ObservationEvent[];
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
    if (o.verdict === "denied" || o.verdict === "payment-failed") earningsMissed += o.price ?? 0;
  }

  const recent = [...inWindow].sort((a, b) => b.at - a.at).slice(0, recentLimit);

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
    recent,
    settled: {
      crossings: settledInWindow.length,
      usdc: settledInWindow.reduce((sum, e) => sum + e.amount, 0),
    },
  };
}
