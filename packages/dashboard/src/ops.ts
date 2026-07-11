/**
 * Turn the gate's raw observation log into the operator's ops summary: the
 * traffic verdicts (who was served free, denied, paid, failed), the earnings it
 * captured vs the earnings it missed, and the agent-identity split (verified via
 * Web Bot Auth vs unsigned vs an outright masquerade). This is what tells a
 * self-hoster their proxy is actually working — distinct from the earnings
 * ledger, which only sees settled money.
 */
import type { ObservationEvent, ObservationVerdict } from "@naulon/shared";

const VERDICTS: ObservationVerdict[] = [
  "served-free",
  "agent-reread",
  "denied",
  "blocked",
  "payment-failed",
  "paid",
];

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
}

const zeroVerdicts = (): Record<ObservationVerdict, number> =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<ObservationVerdict, number>;

export function summarizeOps(
  observations: ObservationEvent[],
  nowMs: number,
  windowMs = 24 * 3_600_000,
  recentLimit = 20,
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
  };
}
