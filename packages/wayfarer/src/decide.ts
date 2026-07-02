/**
 * The decision core — where the Wayfarer earns its "agency" stripes.
 *
 * Given appraised candidates and a budget, decide which essays to PAY for, which
 * to take from CACHE (free, already fetched), and which to SKIP — and say WHY
 * for each. This is a pure function so it's fully testable and the reasoning is
 * inspectable; nothing here is hardcoded to a fixed answer.
 *
 * The default policy: rank by value density (relevance per dollar), buy greedily
 * down the ranking while budget and a relevance floor allow. Greedy-by-density
 * is the natural call when items are cheap relative to budget (the nanopayment
 * case) — it maximizes total relevance bought per dollar without the overhead of
 * solving a knapsack for sub-cent items.
 */
import type { AppraisedCandidate, Decision } from "./types.ts";

export interface DecisionPolicy {
  /**
   * Don't pay for anything below this relevance, however cheap. Protects the
   * budget from spending on near-misses just because they're affordable.
   */
  relevanceFloor: number;
  /** Hard ceiling on how many essays to pay for in one run. */
  maxPaid: number;

  // ── BUY-3.1 operator controls (all optional — omit for the original behavior) ──

  /**
   * Agent identity this run is attributed to. It does NOT alter spend math here —
   * a per-agent cap is applied by the caller resolving that agent's remaining
   * allowance and passing it as `budgetUsdc`. It rides on the policy so the
   * decision log can be tagged per agent in the audit plane (BUY-3.3).
   */
  agentId?: string;
  /**
   * Allowlist of publisher hosts. When set, ONLY these hosts are payable; every
   * other host — and any candidate whose host is unknown — is skipped
   * (deny-by-default). Host match is exact, case-insensitive.
   */
  allowDomains?: string[];
  /** Hosts that are never paid, even when allowed and affordable. Deny wins over allow. */
  denyDomains?: string[];
  /**
   * Max essays to pay for from any single host. Counts pays made this run plus
   * any prior pays for the host in the current window (`context.priorDomainCounts`).
   */
  perDomainCap?: number;
  /**
   * A toll at or above this price is not auto-paid — it becomes an `approve`
   * decision (human gate) instead. Cheaper tolls pay automatically.
   */
  approvalThresholdUsdc?: number;
  /** Kill-switch: when true, halt all new spend this run (free re-reads still allowed). */
  killSwitch?: boolean;
}

/** Runtime state injected into `decide()` that can't be known from the candidates alone. */
export interface DecideContext {
  /**
   * Pays already made to each host in the current rate-cap window (across earlier
   * runs), added to this run's per-host count when enforcing `perDomainCap`.
   */
  priorDomainCounts?: Record<string, number>;
}

/** Normalize a host for policy matching: lower-cased, trimmed; `undefined` stays `undefined`. */
function normHost(host: string | undefined): string | undefined {
  return host?.trim().toLowerCase() || undefined;
}

/**
 * TODO(you): this policy is the lever that defines the agent's "taste". The
 * defaults are sensible, but the interesting choices are yours to make:
 *
 *   - relevanceFloor: how picky? Too low → wastes budget on tangential essays.
 *     Too high → misses useful context. 0.35 is a starting guess.
 *   - Ranking key: density (relevance/price) favors cheap-and-relevant. Would
 *     you instead rank by raw relevance (quality at any price), or blend them?
 *     See `rank()` below — that sort is the whole strategy in one line.
 *   - maxPaid: a stop so a big budget doesn't over-cite a thin topic.
 *
 * Tune these against real runs and watch the decision log; that visible
 * reasoning is what the judges reward.
 */
export const DEFAULT_POLICY: DecisionPolicy = {
  relevanceFloor: 0.35,
  maxPaid: 5,
};

function rank(candidates: AppraisedCandidate[]): AppraisedCandidate[] {
  // Strategy in one line: best relevance-per-dollar first.
  return [...candidates].sort(
    (a, b) => b.relevance / b.price - a.relevance / a.price,
  );
}

export function decide(
  candidates: AppraisedCandidate[],
  budgetUsdc: number,
  cached: ReadonlySet<string> = new Set(),
  policy: DecisionPolicy = DEFAULT_POLICY,
  context: DecideContext = {},
): Decision[] {
  const decisions: Decision[] = [];
  let remaining = budgetUsdc;
  let paidCount = 0;

  const allow = policy.allowDomains?.map((h) => normHost(h)).filter((h): h is string => !!h);
  const deny = new Set((policy.denyDomains ?? []).map((h) => normHost(h)).filter((h): h is string => !!h));
  // Per-host pay tally, seeded with prior pays in this rate-cap window.
  const paidByHost = new Map<string, number>(
    Object.entries(context.priorDomainCounts ?? {}).map(([h, n]) => [normHost(h) ?? h, n]),
  );

  for (const c of rank(candidates)) {
    const price = c.price as number;
    const density = c.relevance / price;
    const host = normHost(c.host);
    const base = { slug: c.slug, title: c.title, relevance: c.relevance, price, density };
    const skip = (reason: string) => decisions.push({ ...base, action: "skip", reason });

    // Free gates first — a held license re-reads for $0, so it is not "spend" and
    // is allowed even under a kill-switch; a below-floor essay was never going to pay.
    if (cached.has(c.slug)) {
      decisions.push({ ...base, action: "cache", reason: `hold a live license — re-read free (saves $${price.toFixed(6)})` });
      continue;
    }
    if (c.relevance < policy.relevanceFloor) {
      skip(`relevance ${c.relevance.toFixed(2)} below floor ${policy.relevanceFloor}`);
      continue;
    }

    // Spend gates.
    if (policy.killSwitch) {
      skip("kill-switch engaged — spend halted");
      continue;
    }
    if (host && deny.has(host)) {
      skip(`host ${host} denied by policy`);
      continue;
    }
    if (allow && (host === undefined || !allow.includes(host))) {
      skip(host === undefined ? "host unknown, not in allowlist" : `host ${host} not in allowlist`);
      continue;
    }
    if (paidCount >= policy.maxPaid) {
      skip(`hit max-paid cap (${policy.maxPaid})`);
      continue;
    }
    if (policy.perDomainCap !== undefined && host !== undefined && (paidByHost.get(host) ?? 0) >= policy.perDomainCap) {
      skip(`per-domain cap (${policy.perDomainCap}) reached for ${host}`);
      continue;
    }
    if (price > remaining) {
      skip(`price $${price.toFixed(6)} exceeds remaining budget $${remaining.toFixed(6)}`);
      continue;
    }
    if (policy.approvalThresholdUsdc !== undefined && price >= policy.approvalThresholdUsdc) {
      decisions.push({
        ...base,
        action: "approve",
        reason: `toll $${price.toFixed(6)} ≥ approval threshold $${policy.approvalThresholdUsdc.toFixed(6)} — needs human approval`,
      });
      continue;
    }

    remaining -= price;
    paidCount += 1;
    if (host !== undefined) paidByHost.set(host, (paidByHost.get(host) ?? 0) + 1);
    decisions.push({
      ...base,
      action: "pay",
      reason: `relevance ${c.relevance.toFixed(2)} @ $${price.toFixed(6)} (density ${density.toFixed(0)}); $${remaining.toFixed(6)} left`,
    });
  }

  return decisions;
}
