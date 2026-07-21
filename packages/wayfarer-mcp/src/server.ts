/**
 * @naulon/wayfarer-mcp — the MCP server factory.
 *
 * Exposes naulon's pay-per-citation pipeline to any MCP-capable LLM. The wayfarer
 * brain runs IN-PROCESS here (no remote service, BYO wallet never leaves the
 * machine) — the deliberate contrast to a thin client that pays a hosted brain.
 *
 * Tools are deliberately GRANULAR and quote-first: the host model sees prices and
 * plans spend before any payment, rather than calling one black-box "research"
 * verb. The §3.1 surface (BUY-1.2) is:
 *
 *   naulon_discover     free — candidate teasers for a topic
 *   naulon_appraise     free — relevance + rationale for teasers the model holds
 *   naulon_quote        free — the x402 402 probe: real price + terms, NO spend
 *   naulon_pay_and_read  $   — pays, returns content + settlementRef + license jti
 *   naulon_read_held    free — re-read a held live license (PoP-signed if cnf-bound)
 *   naulon_research      $   — one composite that runs the whole loop for lazy clients
 *
 * Two deliberate shapes vs the spec's conceptual `url(...)` signatures:
 *   - Tools take a SLUG, never a raw URL. The server resolves it against the
 *     server-configured gate (TOLLGATE_URL), so a prompt-injected model can never
 *     redirect a payment to an attacker's endpoint — payment only ever flows to
 *     the configured gate. (Same "config, not tool args" principle BUY-1.3 applies
 *     to the budget + wallet.)
 *   - `kind` is pinned to "citation": the MCP's purpose is grounded, citable
 *     research, so every quote/pay/re-read asks for a citation license.
 *
 * Budget + wallet are SERVER-CONFIG, never tool args (BUY-1.3). The wallet comes
 * from the env (`BUYER_PRIVATE_KEY` / the dev key) via `getWallet()`; the budget is
 * a single ceiling (`WAYFARER_BUDGET_USDC`) the model cannot raise. Each server
 * instance carries a SESSION SPEND ENVELOPE: every paid read debits a running total,
 * the free tools report "$Y remaining", and a spend that would exceed the ceiling is
 * refused (spending nothing). `naulon_research` accepts an optional `budgetUsdc` the
 * server CLAMPS to what remains — the model can spend less, never more.
 *
 * The explicit toll-moved tolerance + validity-at-pay margin guards are BUY-1.4.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  appraise,
  articleUrl,
  authorizeOrigin,
  buildPopProof,
  decodeHeld,
  DEFAULT_POLICY,
  discover,
  fetchJwks,
  fileHeldStore,
  gatewayBuyer,
  getWallet,
  isLive,
  licenseIdentityFor,
  memoBuyer,
  payHostOf,
  probe,
  probeFailure,
  quotedTotalAtomic,
  railBuyer,
  rereadWithLicense,
  run,
  selectBuyer,
  spendGate,
  tollgateBase,
  verifyAgainst,
} from "@naulon/wayfarer";
import type { AgentWallet, DecisionPolicy, GatewaySigner, HeldStore, MemoSigner, ProbeOutcome, RailSigners } from "@naulon/wayfarer";
import { activeNetwork, getConfig, supportsMemo, usdc } from "@naulon/shared";
import { cloudSignerFromEnv } from "./cloud-signer.ts";

export const SERVER_NAME = "naulon-wayfarer-mcp";
/** Keep in step with this package's package.json `version` — it is what the MCP
 *  handshake reports as `serverInfo.version`. */
export const SERVER_VERSION = "0.2.1";

/** Every MCP toll is a citation license — the agent gathers citable sources. */
const KIND = "citation" as const;

/** The buyer's TRUE outflow for a quote: the sum of every settlement leg (author +
 *  any operator fee), in USDC. `priceUsdc` is only the author leg, so a fee'd toll
 *  costs the buyer more than the advertised price — the budget must debit the total. */
function trueTotalUsdc(quoted: { priceUsdc: number; legs?: { amount: string }[] }): number {
  const legs = quoted.legs;
  // `> 1` MUST match quotedTotalAtomic / assemblePayment: the buyer signs the legs array
  // only for 2+ legs, else it pays priceUsdc (the author leg). Gating the budget on a lone
  // leg would debit a number the buyer never signs — the same ceiling/sign split-brain.
  return legs && legs.length > 1 ? legs.reduce((sum, leg) => sum + Number(leg.amount), 0) / 1_000_000 : quoted.priceUsdc;
}

/** Round a USDC figure to whole micro-USDC for display, dropping float dust (e.g.
 *  0.30000000000000004 → 0.3) so reported budgets read cleanly. */
function round6(usdcAmount: number): number {
  return Math.round(usdcAmount * 1_000_000) / 1_000_000;
}

/** Lowercased host INCLUDING port — endpoint identity, used for the gate origin pin
 *  (a different port is a different service, so it must not satisfy the pin). */
function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Lowercased hostname EXCLUDING port — what operator domain policy matches on, since an
 *  allow/deny list names domains ("evil.example"), never host:port. Also the perDomainCap key. */
function hostnameOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * BUY-1.3 — the ORIGIN PIN, now the SHARED decision. `url` is a MODEL-supplied tool arg and nothing
 * used to check it, so a prompt-injected model (a poisoned discover teaser is enough) could aim
 * quote/pay at an attacker origin whose 402 names the attacker's OWN payTo — and the buyer would
 * sign a real USDC authorization to it.
 *
 * Two questions, two owners, neither reimplemented here:
 *   - `authorizeOrigin` — endpoint IDENTITY. host:port must equal the configured gate, UNLESS the
 *     operator stated a domain boundary, in which case identity steps aside (matching decide.ts,
 *     which this used to have drifted from).
 *   - `spendGate` — operator DOMAIN POLICY (kill-switch / allow / deny / caps).
 *
 * Both run on the FREE probe as well as the pay. That is not belt-and-braces: once an allowlist can
 * replace the identity pin, identity alone no longer bounds what quote may fetch, and an empty
 * allowlist (`[]` — stated, deny-by-default) would leave the probe an open SSRF surface. Whatever
 * spendGate would refuse to pay for, quote must refuse to reach.
 *
 * `priceUsdc: 0` because there is no price yet at origin time — the kill-switch, deny-list and
 * allowlist gates are all price-independent and run first. The price-dependent gates (approval
 * threshold, budget, caps) stay where they are, applied on the pay path once the toll is known.
 *
 * Returns a human-readable refusal, or null when the target is clear to proceed.
 */
function originRefusal(target: string, gate: string, policy: DecisionPolicy): string | null {
  const verdict = authorizeOrigin({
    target,
    gate,
    ...(policy.allowDomains ? { allowDomains: policy.allowDomains } : {}),
  });
  if (!verdict.ok) return verdict.refusal;

  const gated = spendGate({ host: hostnameOf(target) ?? undefined, priceUsdc: 0, policy });
  return gated.ok ? null : gated.reason;
}

/** The pay-time spend ceiling (atomic micro-USDC, integer) the buyer must not exceed:
 *  the gated quote's true total plus the configured tolerance (basis points). With 0
 *  tolerance this is the exact quoted total, so any upward move aborts the pay. */
function guardCeilingAtomic(quoted: { amountAtomic: string; legs?: { amount: string }[] }): string {
  const total = quotedTotalAtomic(quoted as Parameters<typeof quotedTotalAtomic>[0]);
  const bps = BigInt(getConfig().WAYFARER_TOLL_TOLERANCE_BPS);
  return (total + (total * bps) / 10_000n).toString();
}

/** Wrap a structured payload as the dual content/structuredContent an MCP tool
 *  returns: the text block is what a non-structured client sees; structuredContent
 *  is the machine-readable shape matching the tool's outputSchema. */
function structured<T>(payload: T): { content: { type: "text"; text: string }[]; structuredContent: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Per-session options for the HOSTED path (BUY-4). The stdio funnel reads the
 * wallet, budget, and policy from process env (one process = one buyer). The cloud
 * host authenticates MANY buyer sessions over one process, so it injects each
 * session's config here — and each injected value WINS over env, which stays only
 * the default when the option is absent (so the stdio funnel is unchanged). One
 * `buildServer(opts)` per authed session gives per-session budget envelopes for
 * free, since the envelope is a closure over this call.
 */
/**
 * One buyer spend DECISION, handed to a `BuildServerOptions.auditSink` (BUY-4.4). The
 * hosted cloud injects a sink that writes each of these to its org-partitioned audit
 * plane — the same immutable log the sell side uses. A PURE structured hook: the package
 * never imports the cloud (the one-way dependency), so the sink is injected, not called.
 *
 * The four actions mirror the wayfarer decision engine exactly (pay · skip · approve ·
 * cache). A kill-switch halt or a policy denial surfaces as a `skip` with the halt reason
 * carried verbatim in `reason` — so nothing is lost to accountability even though it is
 * not its own verb (the engine emits no distinct "kill"/"deny" action; adding one would
 * be a decide.ts change, not an audit concern).
 */
export interface DecisionAuditEvent {
  /** The source slug the decision was about. */
  slug: string;
  /** The engine decision: paid · skipped (policy/budget/relevance) · flagged for human approval · re-read a held license free. */
  action: "pay" | "skip" | "approve" | "cache";
  /** The engine's human-readable reason (carries the kill-switch / deny / budget nuance verbatim). */
  reason: string;
  /** The candidate's 0..1 relevance for the topic (research decisions). */
  relevance?: number;
  /** The advertised author-leg price in USDC, when known. */
  priceUsdc?: number;
  /** The author leg actually paid, in USDC (pay decisions only). */
  paidUsdc?: number;
  /** The true total debited across all settlement legs, in USDC (pay_and_read pays only). */
  costUsdc?: number;
  /** The on-chain / settlement reference (pay decisions only). */
  settlementRef?: string;
  /** The Citation License jti (pay decisions only). */
  licenseId?: string;
  /** The policy's agent tag, if configured — audit attribution, not identity. */
  agentId?: string;
}

export interface BuildServerOptions {
  /**
   * This session's custody-free cloud signer (else `cloudSignerFromEnv()`). A `MemoSigner`
   * (memo/Arc rail) or a `GatewaySigner` (memo-less Circle rails — Base + every Gateway
   * chain); the cloud injects the one matching the active settlement network's rail, and
   * `buildServer` routes it to the matching buyer (`supportsMemo(activeNetwork())`).
   */
  signer?: MemoSigner | GatewaySigner;
  /**
   * A mixed-fleet session's BOTH rail signers (RAS-B): the cloud injects a memo AND a gateway
   * signer wrapping the same sealed session key, and `buildServer` builds a `railBuyer` that picks
   * the rail from each tenant's advertised 402 — so one process serves an Arc-default fleet with a
   * Base tenant. Takes precedence over `signer` when present; the single-rail `signer` path stays for
   * the stdio funnel and any host that settles on one network. Both wrap the same key, so the payer
   * identity is either signer's `address` (they are equal).
   */
  railSigners?: RailSigners;
  /** This session's spend ceiling in USDC (else `WAYFARER_BUDGET_USDC`). */
  budgetUsdc?: number;
  /** This session's decision policy (else the env-derived policy over DEFAULT_POLICY). */
  policy?: DecisionPolicy;
  /**
   * Per-decision audit hook (BUY-4.4). Invoked once per buyer spend decision — a pay, a
   * skip, an approval-gate, a free cache re-read — with a structured `DecisionAuditEvent`.
   * The cloud host injects a sink that writes to its org-partitioned audit plane; the stdio
   * funnel leaves it unset (no sink ⇒ the OSS path is simply unaudited). A pure hook (the
   * package never imports the cloud), and it is fired best-effort — a throwing sink must
   * never break a paid read.
   */
  auditSink?: (event: DecisionAuditEvent) => void;
  /**
   * This session's gate (base URL) — the fleet tenant it settles into (else the env
   * `TOLLGATE_URL`). The cloud host injects it per authed session so one process can
   * serve many buyers, each accountable to a specific publisher's 402 (BUY-4.2, the
   * moat: own both ends of the receipt). Server-config, never a tool arg — a
   * prompt-injected model can no more redirect the gate than raise the budget.
   */
  tollgateUrl?: string;
  /**
   * This session's held-license backend. The stdio funnel leaves it unset (the
   * process-global file `fileHeldStore`). The cloud host MUST inject a per-session
   * store (e.g. `memoryHeldStore()`) so one process serving many buyers can never
   * let session B re-read the license session A paid for — the file store is keyed
   * by slug alone and shared, so without this the hosted path leaks licenses across
   * buyers. Server-config, never a tool arg.
   */
  heldStore?: HeldStore;
  /**
   * The wallet that signs proof-of-possession for a cnf-bound held re-read. On a
   * custody-free hosted deploy the paying identity is the cloud session EOA, but
   * `getWallet()` (the fallback) returns a throwaway dev key when no
   * `BUYER_PRIVATE_KEY` is set — so a PoP signed by it can never satisfy a license
   * cnf-bound to the session address. The cloud injects a signer backed by its
   * `/sign-pop` BFF (the session key). Absent ⇒ `getWallet()` (unchanged OSS path).
   * Server-config, never a tool arg — the model cannot point the signer elsewhere.
   */
  popWallet?: AgentWallet;
  /**
   * Where the agent (or its operator) tops up / renews the funding session — surfaced on a
   * `needs_topup` / `grant_expired` pay refusal so the refusal is ACTIONABLE, not a dead end. On
   * the hosted path the cloud injects its portal wallet URL; the stdio funnel leaves it at the
   * `/buyer/wallet` default. Server-config, never a tool arg. */
  buyerWalletUrl?: string;
}

/**
 * Build a fresh, unconnected MCP server with the tool surface registered. The
 * caller connects it to a transport (stdio for the OSS funnel; the cloud wraps it
 * over an authenticated HTTP transport). A factory — not a singleton — so tests
 * can stand up an isolated server per case. `opts` supplies per-session config for
 * the hosted path (BUY-4); absent, every value falls back to process env.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ── Session spend envelope ──────────────────────────────────────────────────
  // The budget is server-config, not a tool arg: the ceiling is read fresh from env
  // (so it reflects deployment config), but `spentUsdc` accumulates across this
  // server instance's lifetime — one stdio/HTTP session = one budget envelope. The
  // model sees what remains and can plan within it; it can never raise the ceiling.
  let spentUsdc = 0;
  // Per-session pays per publisher host — the ONE `perDomainCap` counter shared by BOTH spending
  // paths. naulon_pay_and_read increments it directly (below); naulon_research seeds decide()'s own
  // per-host tally from it (`decideContext.priorDomainCounts`) before each run and increments it
  // from that run's `pay` decisions afterward (B3) — so a cap hit through either tool carries to
  // the other, for the life of this session. Never a second, run-scoped counter.
  const paidByHost = new Map<string, number>();
  // ── Spend lock ──────────────────────────────────────────────────────────────
  // The budget check and its debit are separated by network I/O (probe → sign → paid GET), and an
  // MCP client may issue tool calls CONCURRENTLY (a normal parallel tool_use block). Without
  // serialization two pays both read the same `remainingUsdc()`, both pass, and both spend — the
  // ceiling is breached by design-by-accident. The same interleaving loses held licenses, since
  // the persist is a read-modify-write of one store. One lock fixes both: every spending path
  // runs to completion (check → pay → debit → persist) before the next begins.
  let spendChain: Promise<unknown> = Promise.resolve();
  function withSpendLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = spendChain.then(fn, fn);
    // Never let a rejection poison the chain — the next waiter must still run.
    spendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  // Where a needs_topup / grant_expired refusal points the agent to fund/renew (default: the
  // portal wallet path). Server-config, resolved once — never a tool arg.
  const buyerWalletUrl = opts.buyerWalletUrl ?? "/buyer/wallet";
  // Hosted-wallet opt-in (BUY-2): when the cloud env is configured, tolls are signed by naulon's
  // grant-checked /sign-memo BFF (the custody-free session key), so this process holds NO private
  // key. Unset ⇒ the OSS default (BYO BUYER_PRIVATE_KEY via selectBuyer). Server-config, not a tool
  // arg — the model can't point the signer elsewhere. Resolved ONCE per server (one session = one
  // wallet), mirroring the budget envelope.
  // Per-session override wins; else the env default (stdio funnel unchanged).
  const cloudSigner = opts.signer ?? cloudSignerFromEnv();
  // RAS-B mixed fleet: when both rail signers are injected, they wrap the SAME sealed session key,
  // so either one's address is the payer identity. This is the hosted signer for identity + the
  // hosted-armed checks below; the actual rail (which signer pays) is picked per-402 by railBuyer.
  const hostedSigner = opts.railSigners?.memo ?? opts.railSigners?.gateway ?? cloudSigner;
  // The buyer identity a 402 quote / license is bound to. On the hosted path this MUST be the
  // cloud session EOA that actually pays (`hostedSigner.address`) — NOT `getWallet()`, which on a
  // custody-free deploy (no BUYER_PRIVATE_KEY) is a throwaway dev key, so the quote would bind to
  // an identity the buyer never pays from. BYO-key path: fall back to the env wallet, unchanged.
  const payerAddress = (): string => hostedSigner?.address ?? getWallet().address;
  // Per-session held-license store: the injected store (hosted, isolated) wins over the
  // process-global file, so many buyers in one process never cross-read each other's licenses.
  const heldStore: HeldStore = opts.heldStore ?? fileHeldStore;
  // The PoP signer for a cnf-bound held re-read: the injected session-key wallet (hosted) wins
  // over the env wallet. A function so the env default stays fresh when no override is supplied.
  const popWallet = (): AgentWallet => opts.popWallet ?? getWallet();
  // C3 — loud warn when the hosted pay path is armed (a cloud signer is present) but no PoP
  // wallet was injected: held re-reads of cnf-bound licenses will fall back to the mock dev key
  // and fail, silently degrading to re-pay. Surface it instead of letting it look like a toll bug.
  if (hostedSigner && !opts.popWallet && getWallet().mock) {
    console.warn(
      "[wayfarer-mcp] hosted session active (cloud signer present) but no popWallet injected — " +
        "proof-of-possession re-reads will use the mock dev key and cannot satisfy a cnf-bound license. " +
        "Inject BuildServerOptions.popWallet (the /sign-pop session signer) to enable free held re-reads.",
    );
  }
  // This session's gate: the injected fleet tenant (BUY-4.2) wins over env TOLLGATE_URL.
  // A function so the env default stays fresh per call when no override is supplied.
  // Resolved server-side, never from a tool arg — the model can't aim a payment off it.
  const gateBase = (): string => opts.tollgateUrl ?? tollgateBase();
  const slugUrl = (slug: string): string => articleUrl(gateBase(), slug);
  // A non-gated quote must say WHY it isn't gated: a genuine free (2xx) read is very
  // different from a 404 (wrong path — usually the /essays/<slug> fallback missing a
  // /articles/<slug> publisher) or an unreachable origin. Collapsing them into a bare
  // "free read" is the money-correctness footgun this note prevents.
  const quoteNote = (outcome: Exclude<ProbeOutcome, { status: "gated" }>, target: string): string => {
    switch (outcome.status) {
      case "free":
        return "Not gated — this is a free read; no payment is required.";
      case "not_found":
        return (
          `Probed ${target} and got HTTP 404 — this is NOT a free read, the path was not found. ` +
          `Pass the canonical url from naulon_discover (the /essays/<slug> fallback does not match every ` +
          `publisher — many serve /articles/<slug> or a custom path).`
        );
      case "unreachable":
        return `Probed ${target} and got HTTP ${outcome.httpStatus || "no response"} — the origin/gate is unreachable, not a free read. Retry.`;
      case "malformed":
        return `Probed ${target} and got a 402 but ${outcome.reason} — the gate looks misconfigured; cannot quote.`;
    }
  };
  const ceilingUsdc = (): number => opts.budgetUsdc ?? getConfig().WAYFARER_BUDGET_USDC;
  // BUY-3 policy: an injected per-session policy (hosted path) wins; else it is
  // folded from env at call time (server-config, never a tool arg — the model can't
  // relax the allowlist, lift the cap, or disarm the kill-switch), over
  // DEFAULT_POLICY. Enforced inside run()'s decide() step for `naulon_research`.
  const policyFromConfig = (): DecisionPolicy => {
    if (opts.policy) return opts.policy;
    const cfg = getConfig();
    return {
      ...DEFAULT_POLICY,
      ...(cfg.WAYFARER_ALLOW_DOMAINS ? { allowDomains: cfg.WAYFARER_ALLOW_DOMAINS } : {}),
      ...(cfg.WAYFARER_DENY_DOMAINS ? { denyDomains: cfg.WAYFARER_DENY_DOMAINS } : {}),
      ...(cfg.WAYFARER_PER_DOMAIN_CAP !== undefined ? { perDomainCap: cfg.WAYFARER_PER_DOMAIN_CAP } : {}),
      ...(cfg.WAYFARER_APPROVAL_USDC !== undefined ? { approvalThresholdUsdc: cfg.WAYFARER_APPROVAL_USDC } : {}),
      killSwitch: cfg.WAYFARER_KILL_SWITCH,
    };
  };
  const remainingUsdc = (): number => round6(Math.max(0, ceilingUsdc() - spentUsdc));
  /** The session-budget fields every spend-aware tool echoes so the host LLM always
   *  sees the live envelope alongside the tool's own result. */
  const envelope = (): { ceilingUsdc: number; spentSessionUsdc: number; remainingUsdc: number } => ({
    ceilingUsdc: round6(ceilingUsdc()),
    spentSessionUsdc: round6(spentUsdc),
    remainingUsdc: remainingUsdc(),
  });
  // BUY-4.4: hand each buyer decision to the injected audit sink (the cloud writes it to
  // its org audit plane). Best-effort — a misbehaving sink must never break a paid read,
  // mirroring the cloud's own fire-and-forget AuditTrail. No-op when no sink is injected
  // (the stdio funnel: the OSS path is unaudited).
  const emitAudit = (event: DecisionAuditEvent): void => {
    if (!opts.auditSink) return;
    try {
      opts.auditSink(event);
    } catch {
      /* swallow — auditing is never on the critical path of a read */
    }
  };

  // ── naulon_discover (free) ──────────────────────────────────────────────────
  server.registerTool(
    "naulon_discover",
    {
      title: "Discover tollable sources",
      description:
        "Find candidate essays for a topic from the configured publisher (a live RSS feed or a " +
        "catalog endpoint — set RSS_URL, PUBLISHER_URL, or CATALOG_URL, or use the hosted endpoint). " +
        "Returns FREE public teasers only — slug, title, and summary — with no content and no payment. " +
        "Call this first to see what is available before appraising, quoting, or paying. If no source " +
        "is configured it refuses with setup guidance rather than inventing sources.",
      inputSchema: {
        topic: z.string().min(1).describe("The research topic to find candidate sources for."),
      },
      outputSchema: {
        candidates: z
          .array(
            z.object({
              slug: z.string().describe("Stable identifier used to quote and pay for this source."),
              title: z.string(),
              summary: z.string().describe("Free teaser — what the agent reads to judge relevance before paying."),
              url: z
                .string()
                .optional()
                .describe(
                  "Canonical URL this source is served from (from the RSS <link> / catalog / directory). " +
                    "Pass it back to naulon_quote / naulon_pay_and_read so the toll targets the real link " +
                    "(e.g. /articles/<slug>) instead of a reconstructed /essays/<slug> path.",
                ),
            }),
          )
          .describe("Free teasers; the agent has paid for nothing at this stage."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ topic }) => {
      const candidates = await discover(topic);
      return structured({ candidates });
    },
  );

  // ── naulon_appraise (free) ──────────────────────────────────────────────────
  server.registerTool(
    "naulon_appraise",
    {
      title: "Appraise candidates for a topic",
      description:
        "Score how relevant each candidate is to the topic, from its free teaser alone — a 0..1 " +
        "relevance plus a one-line rationale. Pass the candidates you got from naulon_discover (or a " +
        "curated subset). This is FREE and judges the teaser text only; it does not fetch or pay for " +
        "any content. Use it to decide what is worth quoting and paying for.",
      inputSchema: {
        topic: z.string().min(1).describe("The research topic to score relevance against."),
        candidates: z
          .array(
            z.object({
              slug: z.string(),
              title: z.string(),
              summary: z.string().describe("The free teaser to judge — title + summary, no paid content."),
            }),
          )
          .min(1)
          .describe("Candidates to appraise (typically from naulon_discover)."),
      },
      outputSchema: {
        appraised: z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            relevance: z.number().describe("0..1 estimate of usefulness for the topic."),
            rationale: z.string().describe("One-line justification for the score."),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic, candidates }) => {
      // Relevance is judged from the teaser text only — price plays no part, so we
      // appraise with a zero price and drop it from the output.
      const priced = candidates.map((c) => ({ ...c, price: usdc(0) }));
      const scored = await appraise(topic, priced);
      const appraised = scored.map((a) => ({
        slug: a.slug,
        title: a.title,
        relevance: a.relevance,
        rationale: a.rationale,
      }));
      return structured({ appraised });
    },
  );

  // ── naulon_quote (free — the killer tool) ────────────────────────────────────
  server.registerTool(
    "naulon_quote",
    {
      title: "Quote the toll (free price probe)",
      description:
        "Probe the real x402 toll for a source WITHOUT paying — the free 402 price check. Returns " +
        "the author price, the buyer's true total (when the publisher adds extra settlement legs such " +
        "as an operator fee, the total is higher than the author price), and the settlement terms. " +
        "If the source is not gated, returns gated:false (it is a free read — just fetch it). If the " +
        "server refuses to reach the url (off-gate identity, or operator policy such as a kill-switch " +
        "or deny-list), returns refused:true with the reason in note — do NOT fetch it; it is neither " +
        "payable nor free. Quote before paying so you can plan spend against real prices.",
      inputSchema: {
        slug: z.string().min(1).describe("Source slug from naulon_discover."),
        url: z
          .string()
          .optional()
          .describe(
            "Canonical URL from naulon_discover (the source's real link). When present it is probed VERBATIM; " +
              "absent, the slug is reconstructed to the /essays/<slug> template.",
          ),
      },
      outputSchema: {
        gated: z
          .boolean()
          .optional()
          .describe("True if the source requires payment; false if it is a free read. Absent on a refusal (see refused)."),
        refused: z
          .boolean()
          .optional()
          .describe(
            "True if the server refused to reach this url — off-gate identity or operator policy (kill-switch / deny). " +
              "The reason is in note; do NOT fetch it. Mutually exclusive with a gated/free result.",
          ),
        priceUsdc: z.number().optional().describe("The author leg price in USDC."),
        totalUsdc: z.number().optional().describe("The buyer's true total across all settlement legs — what the budget is debited."),
        affordable: z
          .boolean()
          .optional()
          .describe("True if totalUsdc fits within the remaining session budget (only meaningful when gated)."),
        amountAtomic: z.string().optional().describe("The author amount in atomic units (micro-USDC string)."),
        network: z.string().optional(),
        asset: z.string().optional(),
        payTo: z.string().optional().describe("The author payee address."),
        legs: z
          .array(z.object({ role: z.string(), payTo: z.string(), amount: z.string() }))
          .optional()
          .describe("Present only for a multi-leg toll (e.g. author + operator fee)."),
        ceilingUsdc: z.number().describe("The server-configured spend ceiling for this session (cannot be raised from a tool)."),
        spentSessionUsdc: z.number().describe("Total already spent in this MCP session."),
        remainingUsdc: z.number().describe("Budget left for this session — plan spend within this."),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug, url }) => {
      const target = url ?? slugUrl(slug);
      // Origin + policy even on the free probe: an unauthorized url is an SSRF surface and would
      // return an attacker-authored price/payTo the model might then act on.
      const refusal = originRefusal(target, gateBase(), policyFromConfig());
      if (refusal) {
        // A refusal is neither payable nor free: signal refused (not gated:false, which the tool
        // contract defines as "free read — just fetch it" and a buyer would act on).
        return structured({ refused: true, note: refusal, ...envelope() });
      }
      const outcome = await probe(target, KIND, payerAddress());
      if (outcome.status !== "gated") {
        return structured({
          gated: false,
          note: quoteNote(outcome, target),
          ...envelope(),
        });
      }
      const quoted = outcome.quoted;
      const legs = quoted.legs;
      const totalUsdc = round6(trueTotalUsdc(quoted));
      return structured({
        gated: true,
        priceUsdc: quoted.priceUsdc,
        totalUsdc,
        affordable: totalUsdc <= remainingUsdc(),
        amountAtomic: quoted.amountAtomic,
        network: quoted.requirements.network,
        asset: quoted.requirements.asset,
        payTo: quoted.requirements.payTo,
        ...(legs?.length
          ? { legs: legs.map((leg) => ({ role: leg.role, payTo: leg.payTo, amount: leg.amount })) }
          : {}),
        ...envelope(),
      });
    },
  );

  // ── naulon_pay_and_read ($ — spends) ─────────────────────────────────────────
  server.registerTool(
    "naulon_pay_and_read",
    {
      title: "Pay the toll and read the source",
      description:
        "Pay the x402 toll for a source and return its full content, the settlement reference, and the " +
        "Citation License id (jti) — the verifiable proof this read was paid for, which you cite. The " +
        "license is kept so you can re-read this source FREE later with naulon_read_held. This SPENDS " +
        "MONEY from the server-configured wallet, debited from the session budget. The toll is quoted " +
        "first: if it would exceed the remaining session budget the call is REFUSED and spends nothing " +
        "(the budget ceiling is server-configured and cannot be raised from a tool). If the source is not " +
        "gated, or payment is rejected, it returns ok:false and spends nothing.",
      inputSchema: {
        slug: z.string().min(1).describe("Source slug from naulon_discover / naulon_quote."),
        url: z
          .string()
          .optional()
          .describe(
            "Canonical URL from naulon_discover / naulon_quote (the source's real link). When present the toll " +
              "is paid at it VERBATIM; absent, the slug is reconstructed to the /essays/<slug> template.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        content: z.string().optional().describe("The paid-for content."),
        settlementRef: z.string().optional().describe("On-chain / settlement reference for the payment."),
        paidUsdc: z.number().optional().describe("The author leg paid, in USDC."),
        costUsdc: z.number().optional().describe("The true total debited from the session budget (author + any fee legs)."),
        licenseId: z.string().optional().describe("Citation License jti — cite this as proof of a paid read."),
        licenseVerified: z
          .boolean()
          .optional()
          .describe(
            "True/false if the license was checked against the gate's JWKS and canonical iss/aud identity; " +
              "omitted if the JWKS or the gate's canonical identity is unavailable (never a fabricated match).",
          ),
        ceilingUsdc: z.number().describe("The server-configured spend ceiling for this session."),
        spentSessionUsdc: z.number().describe("Total spent in this MCP session (after this call)."),
        remainingUsdc: z.number().describe("Budget left for this session (after this call)."),
        error: z.string().optional(),
        errorCode: z
          .enum([
            "not_gated",
            "not_found",
            "toll_moved",
            "insufficient_funds",
            "expired",
            "rejected",
            "origin_error",
            "needs_topup",
            "grant_expired",
            "settlement_ambiguous",
          ])
          .optional()
          .describe("Typed failure reason when ok:false — lets you decide whether to retry. not_found = the probed URL 404'd (pass the canonical url; it is not a free read). needs_topup = the funding session is exhausted/unset — fund it at topUpUrl. grant_expired = the funding window lapsed (funds intact) — renew at topUpUrl. settlement_ambiguous = the payment-signature was sent and may have settled, but reading the response failed — do NOT blind-retry (a fresh pay could double-charge); verify via settlementRef or a held license first."),
        retryable: z
          .boolean()
          .optional()
          .describe("True if re-quoting/retrying may succeed (toll moved, expired, rejected); false for a hard stop (insufficient funds, needs_topup, grant_expired — the wallet needs funding or renewal, not a retry; settlement_ambiguous — a retry could double-charge)."),
        topUpUrl: z
          .string()
          .optional()
          .describe("Where to fund / renew the session — present only on a needs_topup / grant_expired refusal. Send the operator here; retrying the pay without acting only re-fails."),
        requiredUsdc: z
          .number()
          .optional()
          .describe("The toll (true total, USDC) this call could not cover — present on a needs_topup refusal so the operator knows how much the session is short."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ slug, url }) =>
      withSpendLock(async () => {
      // Quote first and gate on the SESSION BUDGET before any spend. The price is the
      // buyer's true total across legs; refusing here is the budget ceiling (the
      // on-chain insufficient-funds + toll-moved-at-pay tolerance are BUY-1.4).
      // The canonical url (when the model passes it) is the pay target, verbatim — one
      // buyer pays any publisher's URL shape (/articles/, custom domain) without a
      // reconstructed /essays/ template. Absent, fall back to the template.
      const target = url ?? slugUrl(slug);
      // Endpoint identity first — refused targets are never even fetched, so an off-gate url
      // costs nothing and reaches no attacker origin. Operator policy is applied below, once the
      // toll is known (the approval threshold is price-dependent).
      const policy = policyFromConfig();
      const refusal = originRefusal(target, gateBase(), policy);
      if (refusal) {
        emitAudit({ slug, action: "skip", reason: refusal, agentId: policy.agentId });
        return structured({ ok: false, error: refusal, errorCode: "rejected", retryable: false, ...envelope() });
      }
      const outcome = await probe(target, KIND, payerAddress());
      if (outcome.status !== "gated") {
        const failure = probeFailure(outcome, target);
        emitAudit({
          slug,
          action: "skip",
          reason: `not payable: ${failure.errorCode ?? "not_gated"} — ${failure.error ?? ""}`.trim(),
          agentId: policyFromConfig().agentId,
        });
        return structured({
          ok: false,
          error: failure.error ?? "not gated — no payment is required.",
          ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
          ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
          ...envelope(),
        });
      }
      const quoted = outcome.quoted;
      const cost = round6(trueTotalUsdc(quoted));
      // Operator policy — the ONE shared evaluator `decide()` uses, so this granular path and
      // naulon_research enforce byte-identical rules IN THE SAME ORDER (kill-switch, deny/allow,
      // per-domain cap, budget, approval threshold — decide.ts's order is load-bearing). `remainingUsdc`
      // MUST be passed: decide()'s spendGate checks budget BEFORE the approval threshold, so omitting
      // it here let a toll that was BOTH over budget and over the approval threshold fall through to
      // the approval branch and misreport as "needs human approval" — implying approving it would let
      // it proceed, which it would not (the toll is over budget regardless). `paidCount` (the maxPaid
      // gate) stays omitted on purpose — maxPaid is a PER-RUN planning cap for naulon_research's own
      // loop, not a session-wide cap on this granular tool; passing it would newly enforce a 5-pay
      // ceiling across the whole MCP session, which nothing here asked for.
      const payHost = hostnameOf(target);
      const verdict = spendGate({
        host: payHost ?? undefined,
        priceUsdc: cost,
        policy,
        paidForHost: payHost ? (paidByHost.get(payHost) ?? 0) : 0,
        remainingUsdc: remainingUsdc(),
      });
      if (!verdict.ok) {
        const reason =
          verdict.action === "approve"
            ? `${verdict.reason} — NOT auto-paid. Nothing was spent.`
            : `${verdict.reason} — nothing was spent.`;
        emitAudit({ slug, action: verdict.action, reason, priceUsdc: quoted.priceUsdc, agentId: policy.agentId });
        return structured({ ok: false, error: reason, errorCode: "rejected", retryable: false, ...envelope() });
      }
      // NOTE: a redundant `cost > remainingUsdc()` re-check used to live here, AFTER spendGate. It is
      // now unreachable by construction — spendGate is given the same `cost` and the same
      // `remainingUsdc()` above, so if this line is reached the budget gate has already passed. Two
      // implementations of one rule is exactly how the "misreports as approval" bug above happened;
      // it is not re-introduced.

      // Hosted path: sign each leg via the cloud session key. With BOTH rail signers (RAS-B mixed
      // fleet) railBuyer picks the rail from the TENANT's advertised 402 — a gateway 402 signs the
      // Circle envelope even under a memo-default fleet, and vice-versa. With a single injected signer
      // (one-network host / stdio) keep the activeNetwork() branch: a memo-LESS network (Base + every
      // Gateway chain) settles via gatewayBuyer, else memoBuyer. Neither reads BUYER_PRIVATE_KEY.
      // Default: the BYO-key buyer selectBuyer() picks (which branches the same way for the env path).
      const buyer = opts.railSigners
        ? railBuyer(opts.railSigners)
        : cloudSigner
          ? supportsMemo(activeNetwork())
            ? memoBuyer(cloudSigner as MemoSigner)
            : gatewayBuyer(cloudSigner as GatewaySigner)
          : await selectBuyer();
      await buyer.init();
      // Re-quote at pay time and abort if the toll moved past the quote we gated the
      // budget on (BUY-1.4 toll-moved guard). The buyer pays NOTHING if it has moved.
      const result = await buyer.fetch(target, KIND, { maxTotalAtomic: guardCeilingAtomic(quoted) });
      if (!result.ok) {
        // A failed pay is an accountable non-spend: the agent decided to pay, the rail refused.
        // Audit it as a skip carrying the typed failure so the org can see the attempt + cause.
        emitAudit({
          slug,
          action: "skip",
          reason: `payment failed: ${result.errorCode ?? result.error ?? "unknown"} — nothing spent`,
          priceUsdc: quoted.priceUsdc,
          agentId: policyFromConfig().agentId,
        });
        // A hosted session-signer refusal (needs_topup / grant_expired) is actionable, not a dead
        // end: surface WHERE to fund/renew and HOW MUCH the toll was, so the agent points its
        // operator at the fix instead of re-calling a pay that can only fail again.
        const actionable = result.errorCode === "needs_topup" || result.errorCode === "grant_expired";
        return structured({
          ok: false,
          error: result.error ?? "payment failed",
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
          ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
          ...(actionable ? { topUpUrl: buyerWalletUrl, requiredUsdc: cost } : {}),
          ...envelope(),
        });
      }
      // Debit the true total the buyer ACTUALLY authorized (result.costUsdc, computed by the
      // buyer from the quote it signed at pay time), falling back to our pre-pay `cost`. Using
      // costUsdc closes the gap where a pay-time re-quote within tolerance paid more than the
      // pre-pay quote we gated on — the ledger would otherwise understate real spend. result.paidUsdc
      // is only the author leg, so it would under-count a fee'd toll against the budget.
      spentUsdc = round6(spentUsdc + (result.costUsdc ?? cost));
      if (payHost) paidByHost.set(payHost, (paidByHost.get(payHost) ?? 0) + 1);

      let licenseId: string | undefined;
      let licenseVerified: boolean | undefined;
      if (result.license) {
        const decoded = decodeHeld(result.license);
        if (decoded) {
          licenseId = decoded.jti;
          // BEST-EFFORT, exactly like emitAudit: the money has ALREADY moved by here. A hosted
          // store (DB/KV) that throws on a transient failure must never turn a successful paid
          // read into an error — that would lose the content + receipt the buyer just paid for
          // and push the agent to pay again. Persisting the license is a caching nicety; the
          // paid read is the product.
          try {
            const held = await heldStore.load();
            // Capture the url actually paid so a later read_held re-fetches THIS link
            // verbatim, not a reconstructed /essays/<slug> template that 404s off-shape.
            held.set(decoded.slug, { ...decoded, jws: result.license, url: target });
            await heldStore.save(held);
          } catch {
            /* swallow — a held-license persist failure must never fail an already-paid read */
          }
        }
        const jwks = await fetchJwks(gateBase());
        // The canonical identity of the gate this read just settled into — derived from
        // `target` (the paid url), never from the token's own claims (A4). Cosmetic/log
        // field only: it does not gate the payment or the license persist above, both of
        // which already happened by this point regardless of licenseVerified's value.
        const identity = licenseIdentityFor(target);
        if (jwks && identity) licenseVerified = verifyAgainst(result.license, jwks, { issuer: identity, audience: identity });
      }

      emitAudit({
        slug,
        action: "pay",
        reason: `paid $${round6(result.paidUsdc ?? 0)} (true total $${cost})`,
        priceUsdc: quoted.priceUsdc,
        paidUsdc: result.paidUsdc,
        costUsdc: cost,
        ...(result.settlementRef ? { settlementRef: result.settlementRef } : {}),
        ...(licenseId ? { licenseId } : {}),
        agentId: policyFromConfig().agentId,
      });

      return structured({
        ok: true,
        content: result.content,
        settlementRef: result.settlementRef,
        paidUsdc: result.paidUsdc,
        // Report the total ACTUALLY authorized (what the budget was debited), not the pre-pay quote.
        costUsdc: result.costUsdc ?? cost,
        ...(licenseId ? { licenseId } : {}),
        ...(licenseVerified === undefined ? {} : { licenseVerified }),
        ...envelope(),
      });
      }),
  );

  // ── naulon_read_held (free) ──────────────────────────────────────────────────
  server.registerTool(
    "naulon_read_held",
    {
      title: "Re-read a source you already licensed (free)",
      description:
        "Re-read a source you previously paid for, FREE, using the held Citation License — no second " +
        "payment. If the license is holder-of-key bound, a fresh wallet proof-of-possession is signed " +
        "automatically. Returns ok:false (telling you to pay) if no live license is held for the slug.",
      inputSchema: {
        slug: z.string().min(1).describe("Source slug you previously paid for with naulon_pay_and_read."),
      },
      outputSchema: {
        ok: z.boolean(),
        content: z.string().optional(),
        licenseId: z.string().optional(),
        paidUsdc: z.number().optional().describe("Always 0 on a held re-read."),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ slug }) => {
      const held = await heldStore.load();
      const license = held.get(slug);
      if (!license) {
        return structured({
          ok: false,
          error: "No held license for this slug — pay for it first with naulon_pay_and_read.",
        });
      }
      if (!isLive(license, Math.floor(Date.now() / 1000))) {
        return structured({ ok: false, error: "Held license has expired — pay again with naulon_pay_and_read." });
      }

      let proof: string | undefined;
      if (license.pop) {
        proof = (await buildPopProof(license, popWallet(), Date.now())) ?? undefined;
        if (!proof) {
          return structured({
            ok: false,
            error: "License is holder-of-key bound but the wallet cannot sign — pay again instead.",
          });
        }
      }

      // Re-read the exact url the license was paid at; fall back to the template only
      // for a legacy license captured before the url was stored.
      const target = license.url ?? slugUrl(slug);
      const reread = await rereadWithLicense(target, KIND, license.jws, popWallet().address, proof);
      if (!reread.ok) {
        return structured({ ok: false, error: reread.error ?? "re-read failed" });
      }
      return structured({ ok: true, content: reread.content, licenseId: license.jti, paidUsdc: 0 });
    },
  );

  // ── naulon_research ($ — composite) ──────────────────────────────────────────
  server.registerTool(
    "naulon_research",
    {
      title: "Research a topic end-to-end (composite)",
      description:
        "The lazy-client convenience: run the whole loop — discover → quote → appraise → decide → pay → " +
        "ground — for a topic and return a grounded answer with cited, paid-for sources, the spend, the " +
        "per-candidate decisions (with reasons), and the full decision log. Spend is bounded by the " +
        "session budget. You MAY pass budgetUsdc to spend LESS on this run, but it is clamped to what " +
        "remains in the session — you can lower the cap, never raise it. This SPENDS MONEY. Prefer the " +
        "granular tools when you want to see prices and plan spend yourself before paying.",
      inputSchema: {
        topic: z.string().min(1).describe("The research topic."),
        budgetUsdc: z
          .number()
          .positive()
          .optional()
          .describe("Optional cap for THIS run, in USDC. Clamped to the remaining session budget — lowers the cap only, never raises it."),
      },
      outputSchema: {
        topic: z.string(),
        budget: z.number().describe("The effective spend cap applied to this run (the clamped budget), in USDC."),
        requestedBudgetUsdc: z.number().optional().describe("The budgetUsdc you asked for, if it was clamped down to the remaining session budget."),
        ceilingUsdc: z.number().describe("The server-configured session ceiling (cannot be raised from a tool)."),
        spent: z.number().describe("Total actually spent on this run, in USDC."),
        spentSessionUsdc: z.number().describe("Total spent across the whole MCP session (after this run)."),
        remainingUsdc: z.number().describe("Budget left for this session (after this run)."),
        answer: z.string().describe("The grounded answer, citing the paid sources."),
        decisions: z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            action: z.string().describe("pay | skip | cache"),
            reason: z.string(),
            relevance: z.number(),
            price: z.number(),
          }),
        ),
        sources: z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            content: z.string(),
            paidUsdc: z.number(),
            settlementRef: z.string().optional(),
            licenseId: z.string().optional(),
          }),
        ),
        log: z.array(z.string()).describe("The auditable, human-readable decision log for the run."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ topic, budgetUsdc }) =>
      withSpendLock(async () => {
      const log: string[] = [];
      // Clamp the requested budget to what the session has left: the model can spend
      // less than the ceiling, never more. Passing the clamp into run() overrides its
      // config ceiling for this run only.
      const effective = round6(Math.min(budgetUsdc ?? ceilingUsdc(), remainingUsdc()));
      const result = await run(topic, (line) => log.push(line), {
        budgetUsdc: effective,
        policy: policyFromConfig(),
        // B3: seed decide()'s per-host tally from the SAME session `paidByHost` the granular
        // naulon_pay_and_read path maintains (declared once above), so a perDomainCap already hit
        // via pay_and_read carries into this run instead of decide() starting every call at 0.
        // One counter for the whole session — never a second, run-scoped one.
        decideContext: { priorDomainCounts: Object.fromEntries(paidByHost) },
        ...(opts.tollgateUrl ? { tollgateUrl: opts.tollgateUrl } : {}),
        // Hosted path: pay from the buyer's custody-free session wallet, not the env key
        // (mirrors naulon_pay_and_read). Both rail signers win — run() then rail-picks PER-402
        // (mixed fleet), same as the pay_and_read buyer above; a single cloud signer keeps the
        // fleet-global routing. Absent ⇒ run() falls back to selectBuyer().
        ...(opts.railSigners
          ? { railSigners: opts.railSigners }
          : cloudSigner
            ? { signer: cloudSigner }
            : {}),
        // Same per-session isolation + PoP identity for the composite loop's held re-reads.
        ...(opts.heldStore ? { heldStore: opts.heldStore } : {}),
        ...(opts.popWallet ? { popWallet: opts.popWallet } : {}),
      });
      spentUsdc = round6(spentUsdc + result.spent);
      // B3: fold this run's actual pays back into the session counter, resolving each host via
      // the SAME `payHostOf` decide() itself counts by (never `Decision.url` blindly, never a
      // second resolver) — so a later naulon_pay_and_read or naulon_research call in this session
      // sees them too.
      for (const d of result.decisions) {
        if (d.action !== "pay") continue;
        const host = payHostOf(d.url, gateBase(), d.slug);
        if (host) paidByHost.set(host, (paidByHost.get(host) ?? 0) + 1);
      }
      // BUY-4.4: audit each decision the run made. run() owns the decide()/pay loop
      // internally, so we replay its decisions here post-run — enriching a `pay` with the
      // settlement detail from the matching cited source. agentId is a policy tag (audit
      // attribution), read once for the whole run.
      const sourceBySlug = new Map(result.sources.map((s) => [s.slug, s]));
      const runAgentId = policyFromConfig().agentId;
      for (const d of result.decisions) {
        const src = d.action === "pay" ? sourceBySlug.get(d.slug) : undefined;
        emitAudit({
          slug: d.slug,
          action: d.action,
          reason: d.reason,
          relevance: d.relevance,
          priceUsdc: d.price,
          ...(src
            ? {
                paidUsdc: src.paidUsdc,
                ...(src.settlementRef ? { settlementRef: src.settlementRef } : {}),
                ...(src.licenseId ? { licenseId: src.licenseId } : {}),
              }
            : {}),
          ...(runAgentId ? { agentId: runAgentId } : {}),
        });
      }
      const wasClamped = budgetUsdc !== undefined && effective < budgetUsdc;
      return structured({
        topic: result.topic,
        budget: round6(result.budget),
        ...(wasClamped ? { requestedBudgetUsdc: budgetUsdc } : {}),
        spent: round6(result.spent),
        ...envelope(),
        answer: result.answer,
        decisions: result.decisions.map((d) => ({
          slug: d.slug,
          title: d.title,
          action: d.action,
          reason: d.reason,
          relevance: d.relevance,
          price: d.price,
        })),
        sources: result.sources.map((s) => ({
          slug: s.slug,
          title: s.title,
          content: s.content,
          paidUsdc: s.paidUsdc,
          ...(s.settlementRef ? { settlementRef: s.settlementRef } : {}),
          ...(s.licenseId ? { licenseId: s.licenseId } : {}),
        })),
        log,
      });
      }),
  );

  // ── Prompts (cross-client slash commands) ───────────────────────────────────
  // MCP prompts are the client-agnostic UX layer: any prompts-capable host (Claude
  // Code / Desktop as `/mcp__<server>__<name>`, Cursor, VS Code, Cline, …) surfaces
  // these as first-class, argument-taking slash commands — zero per-user config. They
  // only orchestrate the tools THIS server exposes (the free-first quote→pay→ground
  // loop); the cloud layers its own `naulon_ask` prompt where that tool lives. Each
  // returns a single user message that steers the host model through the tools; the
  // model still sees every price and spends only when a paying tool is called.
  server.registerPrompt(
    "research",
    {
      title: "Research a topic (naulon)",
      description:
        "Discover naulon-tolled sources for a topic, see prices before paying, then return a grounded, cited answer within budget.",
      argsSchema: { topic: z.string().describe("The topic to research.") },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Research "${topic}" using naulon's tolled sources.\n\n` +
              `1. Call naulon_discover("${topic}") — free — to list candidate essays.\n` +
              `2. Use naulon_appraise and naulon_quote to judge relevance and see exact prices. Nothing is spent until a paying tool runs.\n` +
              `3. Pay only the most relevant sources with naulon_pay_and_read, or call naulon_research to run the whole discover→quote→pay→ground loop within the session budget.\n\n` +
              `Return a grounded answer with numbered citations and report exactly what was spent. Distinguish naulon-cited evidence from your own general knowledge.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "discover",
    {
      title: "Discover sources (naulon, free)",
      description: "List naulon-tolled sources for a topic — free teasers only, no payment.",
      argsSchema: { topic: z.string().describe("The topic to find sources for.") },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call naulon_discover("${topic}") and present the candidate essays as a ranked list — title, one-line summary, teaser price, and citation price. ` +
              `This is FREE: do not pay for anything. If a grounded answer is wanted next, use the "research" prompt or naulon_research.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "verify",
    {
      title: "Fact-check a claim (naulon)",
      description: "Check whether a claim is supported by naulon-tolled sources, citing what it paid for.",
      argsSchema: { claim: z.string().describe("The claim to fact-check.") },
    },
    ({ claim }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Fact-check the claim: "${claim}".\n\n` +
              `Use naulon_discover to find relevant tolled sources, then naulon_appraise / naulon_quote (free) to see relevance and price. ` +
              `Only if grounding needs it, pay the most relevant sources with naulon_pay_and_read (or run naulon_research) within budget.\n\n` +
              `State whether the claim is SUPPORTED, REFUTED, or UNVERIFIABLE, cite the paid sources by title, and report the spend. Keep naulon-cited evidence separate from your own general knowledge.`,
          },
        },
      ],
    }),
  );

  return server;
}
