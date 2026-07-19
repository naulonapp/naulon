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
  /**
   * The configured gate base URL. Supplied so `decide()` can resolve a slug-only candidate to the
   * SAME url the pay step will use (`c.url ?? articleUrl(gateBase, c.slug)`), and evaluate domain
   * policy against that real target. Without it a slug-only candidate has no derivable host and is
   * treated as unknown — which an allowlist correctly denies by default.
   */
  gateBase?: string;
}

/** Normalize a host for policy matching: lower-cased, trimmed; `undefined` stays `undefined`. */
function normHost(host: string | undefined): string | undefined {
  return host?.trim().toLowerCase() || undefined;
}

/**
 * The hostname money will actually go to, mirroring the pay step's own resolution
 * (`c.url ?? articleUrl(gateBase, c.slug)`). This — not the discovery source's `Candidate.host`
 * field — is what domain policy is evaluated against, so an allow/deny decision can never be made
 * about a different host than the one that gets paid. Returns undefined when no url is derivable
 * (an allowlist then denies by default).
 */
export function payHostOf(url: string | undefined, gateBase: string | undefined, slug: string): string | undefined {
  const candidates = [url, gateBase && slug ? `${gateBase.replace(/\/+$/, "")}/${slug}` : undefined];
  for (const u of candidates) {
    if (!u) continue;
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      /* not a parseable absolute URL — fall through to the next candidate */
    }
  }
  return undefined;
}

/** The shared spend gate's verdict. `approve` means "real, but needs a human" — distinct from
 *  `skip` so callers can surface a human-approval affordance rather than a flat refusal. */
export type SpendVerdict = { ok: true } | { ok: false; action: "skip" | "approve"; reason: string };

/**
 * THE operator-policy gate — the single source of truth for "may I pay this host, at this price,
 * right now". Every spending path calls this: `decide()` for the composite research run, and the
 * MCP's granular `naulon_pay_and_read`.
 *
 * It exists because the checks previously lived ONLY inside `decide()`, so the granular pay tool
 * — the path the tool descriptions tell agents to prefer — silently ignored the kill-switch,
 * deny/allow lists, per-domain cap, and approval threshold an operator had configured. Two
 * implementations of one rule is how that bug happens; there is now one implementation.
 *
 * Order is load-bearing and matches the original `decide()` sequence, so the reason a caller
 * surfaces when several gates apply is unchanged: kill → deny → allow → maxPaid → perDomainCap →
 * budget → approval. `paidCount` / `remainingUsdc` are optional; omit them when the caller
 * enforces those with its own accounting and messaging (the MCP session envelope does).
 */
export function spendGate(input: {
  /** Publisher host, already normalized-ish; undefined when unknown (deny-by-default under an allowlist). */
  host: string | undefined;
  /** The buyer's TRUE total for this read, in USDC. */
  priceUsdc: number;
  policy: DecisionPolicy;
  /** Pays already made for this host (this run/session + any prior window). */
  paidForHost?: number;
  /** Pays already made overall — enables the `maxPaid` gate when provided. */
  paidCount?: number;
  /** Budget left in USDC — enables the budget gate when provided. */
  remainingUsdc?: number;
}): SpendVerdict {
  const { policy, priceUsdc } = input;
  const host = normHost(input.host);
  if (policy.killSwitch) return { ok: false, action: "skip", reason: "kill-switch engaged — spend halted" };

  const deny = new Set((policy.denyDomains ?? []).map((h) => normHost(h)).filter((h): h is string => !!h));
  if (host && deny.has(host)) return { ok: false, action: "skip", reason: `host ${host} denied by policy` };

  // NOTE: a DEFINED but empty allowlist denies everything (deny-by-default). That is deliberate —
  // "I configured an allowlist and it is empty" must not read as "allow all".
  const allow = policy.allowDomains?.map((h) => normHost(h)).filter((h): h is string => !!h);
  if (allow && (host === undefined || !allow.includes(host))) {
    return {
      ok: false,
      action: "skip",
      reason: host === undefined ? "host unknown, not in allowlist" : `host ${host} not in allowlist`,
    };
  }

  if (input.paidCount !== undefined && input.paidCount >= policy.maxPaid) {
    return { ok: false, action: "skip", reason: `hit max-paid cap (${policy.maxPaid})` };
  }
  if (policy.perDomainCap !== undefined && host !== undefined && (input.paidForHost ?? 0) >= policy.perDomainCap) {
    return { ok: false, action: "skip", reason: `per-domain cap (${policy.perDomainCap}) reached for ${host}` };
  }
  if (input.remainingUsdc !== undefined && priceUsdc > input.remainingUsdc) {
    return {
      ok: false,
      action: "skip",
      reason: `price $${priceUsdc.toFixed(6)} exceeds remaining budget $${input.remainingUsdc.toFixed(6)}`,
    };
  }
  if (policy.approvalThresholdUsdc !== undefined && priceUsdc >= policy.approvalThresholdUsdc) {
    return {
      ok: false,
      action: "approve",
      reason: `toll $${priceUsdc.toFixed(6)} ≥ approval threshold $${policy.approvalThresholdUsdc.toFixed(6)} — needs human approval`,
    };
  }
  return { ok: true };
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

  // Per-host pay tally, seeded with prior pays in this rate-cap window.
  const paidByHost = new Map<string, number>(
    Object.entries(context.priorDomainCounts ?? {}).map(([h, n]) => [normHost(h) ?? h, n]),
  );

  for (const c of rank(candidates)) {
    const price = c.price as number;
    const density = c.relevance / price;
    // SECURITY: the policy host MUST come from the url the pay step will actually fetch — never
    // from `Candidate.host`, a free-form string the (untrusted) discovery source supplies ALONGSIDE
    // the url. A malicious feed returning { host: "trusted-publisher.com", url:
    // "https://attacker.example/toll" } would otherwise pass an allow/deny check on one string while
    // real USDC went to another. Underivable ⇒ undefined ⇒ "host unknown", which an allowlist
    // denies by default (see spendGate). `c.host` is now display/telemetry only.
    const host = payHostOf(c.url, context.gateBase, c.slug);
    const base = { slug: c.slug, title: c.title, url: c.url, relevance: c.relevance, price, density };
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

    // ORIGIN PIN (the run()/research counterpart of the MCP's originPinRefusal). Sits with the
    // SPEND gates, after the free ones — a held-license re-read costs nothing and stays allowed.
    //
    // A discovery source is untrusted: `catalogSource` casts a remote endpoint's JSON straight to
    // Candidate[], so a compromised catalog can hand back any `url` it likes and money would follow
    // it. Every shipped discovery knob is singular (RSS_URL > PUBLISHER_URL > CATALOG_URL, one
    // TOLLGATE_URL), so the default posture is: pay only the configured gate.
    //
    // Multi-gate buying is opt-in through the EXISTING `allowDomains` — deliberately NOT a separate
    // "multiGate" flag, which would be a second way to express "which hosts may I pay" and would
    // drift from this one. Setting an allowlist IS naming your trust boundary, and spendGate
    // enforces it below against this same real pay host.
    const gateHost = payHostOf(undefined, context.gateBase, "_");
    if (!policy.allowDomains && gateHost !== undefined && host !== gateHost) {
      skip(
        host === undefined
          ? `no resolvable pay URL — refusing (the configured gate is ${gateHost})`
          : `host ${host} is not the configured gate (${gateHost}); set allowDomains to buy across publishers`,
      );
      continue;
    }

    // Spend gates — delegated to the ONE shared evaluator (see `spendGate`), so the granular
    // MCP pay path enforces byte-identical rules instead of a drifting second copy.
    const verdict = spendGate({
      host,
      priceUsdc: price,
      policy,
      paidForHost: host === undefined ? 0 : (paidByHost.get(host) ?? 0),
      paidCount,
      remainingUsdc: remaining,
    });
    if (!verdict.ok) {
      decisions.push({ ...base, action: verdict.action, reason: verdict.reason });
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
