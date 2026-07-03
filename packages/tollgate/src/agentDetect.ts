/**
 * Human vs. machine classification — the hinge of the whole thesis.
 *
 * "Humans read free, forever. Machines pay." Everything downstream trusts this
 * call. The asymmetry that matters:
 *
 *   - False positive (human flagged as agent) -> a human hits a 402 paywall.
 *     This BREAKS the "open to all" promise. Worst outcome. Bias away from it.
 *   - False negative (agent flagged as human) -> a crawler reads free. We lose a
 *     micro-toll. Cheap. Tolerable.
 *
 * So the classifier should be conservative: only charge when we're confident the
 * caller is a machine. Signed intent (an agent that *declares* itself via the
 * x402 handshake) is the strongest, cleanest signal — it sidesteps the UA
 * arms race entirely.
 */

export type Verdict = { kind: "human" | "agent"; reason: string; confidence: number };

/** Request facts the classifier reasons over (framework-agnostic). */
export interface RequestSignals {
  userAgent: string;
  /** Present when the caller already speaks x402 (declared intent to pay). */
  hasPaymentHeader: boolean;
  /** Explicit opt-in header an agent may send: `X-Naulon-Agent: <id>`. */
  declaredAgentId: string | null;
  /** Accept header — browsers ask for text/html; many bots don't. */
  accept: string;
  headers: Record<string, string>;
}

/** Per-publisher classification policy the gate supplies from `PublisherConfig`. */
export interface ClassifyPolicy {
  /**
   * Verified search / discovery crawler UA fragments that read FREE for this
   * publisher (their SEO allowlist). Honored ahead of the known-agent list, so an
   * allowlisted crawler is freed even if its UA also looks like a bot — the point
   * is to never toll the crawlers a publisher needs for indexing. Matched
   * case-insensitively against the user-agent. UA is spoofable; verifying crawler
   * identity (reverse DNS / Web Bot Auth) is a later hardening — for now a
   * publisher's own allowlist is the stored intent we honor.
   */
  seoAllowlist?: string[];
  /**
   * Publisher-charged UA fragments. Honored between the allowlist and the built-in
   * known-agent list: fragments a publisher explicitly charges are classified as
   * agents even when the conservative default would read the UA as browser-shaped or
   * ambiguous (and thus free). Allow wins over charge on overlap.
   */
  chargeList?: string[];
}

/**
 * Obvious crawler/agent UA fragments. Extend freely — this is a weak signal.
 * Verified against the operators' own published UA docs 2026-07-03 (Anthropic:
 * ClaudeBot/Claude-User/Claude-SearchBot; OpenAI: GPTBot/ChatGPT-User/
 * OAI-SearchBot/OAI-AdsBot). Dropped as undocumented: claude-web, anthropic-ai.
 * Dropped as unmatchable: google-extended (a robots.txt-only token — Google
 * documents NO UA string for it, so a UA fragment could never fire).
 *
 * Two kinds of machine read are charged here:
 *   - training/bulk crawlers (gptbot, claudebot, ccbot, bytespider, amazonbot,
 *     applebot-extended, meta-externalagent);
 *   - user-triggered assistant fetches (chatgpt-user, claude-user,
 *     perplexity-user, perplexitybot) — the citation moment itself. These UAs are
 *     machine-only (no human browser carries them), so charging them cannot toll
 *     a human; an x402-capable agent answers the 402 by paying, which is the
 *     product working, not a wall.
 *
 * Note: pure search-indexer UAs (googlebot, bingbot, claude-searchbot,
 * oai-searchbot, …) are deliberately NOT here. Tolling a search crawler silently
 * deindexes the publisher — the opposite of what they want — so indexing reads
 * free by default. A publisher frees additional crawlers (or re-affirms search
 * ones) via `ClassifyPolicy.seoAllowlist`, or charges one via `chargeList`.
 */
const KNOWN_AGENT_UA = [
  "gptbot",
  "chatgpt-user",
  "claudebot",
  "claude-user",
  "perplexitybot",
  "perplexity-user",
  "ccbot",
  "bytespider",
  "amazonbot",
  "applebot-extended",
  "meta-externalagent",
  "python-requests",
  "node-fetch",
  "axios",
  "curl",
  "wget",
  "langchain",
];

/**
 * First fragment (case-insensitive substring) of `fragments` found in `ua`,
 * else undefined. The one matching primitive the tri-state policy shares with
 * the allowlist path — swap THIS for verified identity (Web Bot Auth) later.
 */
export function matchUaFragment(ua: string, fragments: string[] | undefined): string | undefined {
  if (!fragments?.length) return undefined;
  const lower = ua.toLowerCase();
  return fragments.find((f) => f.length > 0 && lower.includes(f.toLowerCase()));
}

/**
 * Classify a request as human or agent.
 *
 * TODO(you): implement the core heuristic. A starter is provided so the gate
 * runs today, but this decision shapes the product — own it. Consider:
 *
 *   1. Declared intent first. `signals.hasPaymentHeader` or
 *      `signals.declaredAgentId` => almost certainly an agent that WANTS to pay.
 *      Treat as high-confidence agent. (Already wired below — keep it first.)
 *   2. Known-bot UA match => agent, but lower confidence (UAs are spoofable and
 *      churn). Decide how much weight to give a raw UA match.
 *   3. Browser-shaped requests (Accept: text/html, sec-fetch-* headers,
 *      Accept-Language present) => lean human. Decide your "looks like a real
 *      browser" bar.
 *   4. The ambiguous middle (empty UA, generic Accept, no browser headers).
 *      THIS is the real design call: default-allow (favor humans, lose tolls) or
 *      default-charge (capture tolls, risk paywalling a human)? Given the
 *      asymmetry above, the starter defaults to HUMAN. Change it if you disagree
 *      — and write down why.
 *
 * Return a Verdict with a `reason` (it surfaces in logs + the demo) and a
 * `confidence` in [0,1].
 *
 * `policy` carries per-publisher overrides (the SEO allowlist); the single-tenant
 * default passes none and behaves exactly as before.
 */
export function classify(signals: RequestSignals, policy?: ClassifyPolicy): Verdict {
  // 1) Declared intent — strongest, spoof-proof-in-spirit signal. Leave first.
  if (signals.hasPaymentHeader) {
    return { kind: "agent", reason: "presented x402 payment header", confidence: 0.99 };
  }
  if (signals.declaredAgentId) {
    return { kind: "agent", reason: `declared agent id ${signals.declaredAgentId}`, confidence: 0.95 };
  }

  const ua = signals.userAgent.toLowerCase();

  // 2) SEO allowlist — verified discovery crawlers this publisher wants indexed
  //    read FREE. Before the known-bot check so an allowlisted crawler is freed
  //    even when its UA also matches a known-bot fragment.
  const allowed = policy?.seoAllowlist?.find((frag) => ua.includes(frag.toLowerCase()));
  if (allowed) {
    return { kind: "human", reason: `seo allowlist matched "${allowed}"`, confidence: 0.9 };
  }

  // 2b) Publisher-charged crawlers — fragments the publisher explicitly tolls.
  //     After allow (allow wins) and before the built-in list, so a publisher
  //     can charge a crawler the conservative default would read as human.
  const charged = matchUaFragment(signals.userAgent, policy?.chargeList);
  if (charged) {
    return { kind: "agent", reason: `publisher charge policy matched "${charged}"`, confidence: 0.8 };
  }

  // 3) Known-bot UA — weak, spoofable signal.
  const hit = KNOWN_AGENT_UA.find((frag) => ua.includes(frag));
  if (hit) {
    return { kind: "agent", reason: `user-agent matched "${hit}"`, confidence: 0.8 };
  }

  // 4) Browser-shaped => human.
  const looksBrowser = signals.accept.includes("text/html") || "sec-fetch-mode" in signals.headers;
  if (looksBrowser) {
    return { kind: "human", reason: "browser-shaped request", confidence: 0.85 };
  }

  // 5) Ambiguous middle. Starter favors humans (see asymmetry note).
  return { kind: "human", reason: "ambiguous; defaulting to human (free)", confidence: 0.4 };
}
