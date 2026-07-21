/**
 * The Wayfarer pipeline: discover → price → appraise → decide → pay → ground.
 *
 * Each stage is explicit and logged, so the agent's reasoning is auditable — the
 * decision log is the artifact, not a black box. Paying runs against the
 * tollgate over the real x402 contract; the Buyer is mock (offline) or Circle
 * Gateway (PAYMENT_MODE=gateway), chosen at startup.
 */
import { activeNetwork, getConfig, supportsMemo, usdc, verifyLicense, type JwkSet } from "@naulon/shared";
import { appraise } from "./appraise.ts";
import { quotedTotalAtomic, rereadWithLicense, selectBuyer } from "./buyer.ts";
import { gatewayBuyer, type GatewaySigner } from "./gateway.ts";
import { memoBuyer, type MemoSigner } from "./memo.ts";
import { railBuyer, type RailSigners } from "./rail.ts";
import { decide, DEFAULT_POLICY, payHostOf, payUrlOf, spendGate } from "./decide.ts";
import type { DecideContext, DecisionPolicy } from "./decide.ts";
import { discover } from "./discover.ts";
import { authorizeOrigin } from "./origin-policy.ts";
import { decodeHeld, fileHeldStore, isLive } from "./licenseStore.ts";
import type { HeldStore } from "./licenseStore.ts";
import { buildPopProof } from "./pop.ts";
import { agentFetch } from "./sign.ts";
import type { AppraisedCandidate, PricedCandidate, RunResult, Source } from "./types.ts";
import { getWallet } from "./wallet.ts";
import type { AgentWallet } from "./wallet.ts";

export type Logger = (line: string) => void;

export function tollgateBase(): string {
  const url = getConfig().TOLLGATE_URL;
  // No fail-open: an unset gate is a config error surfaced here, not a fabricated
  // http://localhost target that refuses later with a confusing "unreachable host".
  // Callers prefer an injected per-session `opts.tollgateUrl`; this is only reached
  // when neither is set.
  if (!url) throw new Error("TOLLGATE_URL is not configured");
  return url;
}

export function articleUrl(base: string, slug: string): string {
  return `${base.replace(/\/$/, "")}/essays/${encodeURIComponent(slug)}`;
}

/** Fetch the gate's public key set so the agent can verify the receipts it holds. */
export async function fetchJwks(base: string): Promise<JwkSet | null> {
  try {
    const res = await agentFetch(`${base.replace(/\/$/, "")}/.well-known/naulon-jwks.json`);
    if (!res.ok) return null;
    const set = (await res.json()) as JwkSet;
    return set.keys?.length ? set : null;
  } catch {
    return null;
  }
}

/** Verify a captured license against the gate's JWKS. null when JWKS unavailable. */
export function verifyAgainst(jws: string, jwks: JwkSet): boolean {
  try {
    const claims = JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      iss?: string;
      aud?: string;
    };
    const r = verifyLicense(jws, {
      now: Date.now(),
      expectedIssuer: claims.iss ?? "",
      expectedAudience: claims.aud ?? "",
      jwks,
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Optional overrides for a single run. `budgetUsdc` lets a caller spend LESS than
 *  the configured ceiling for this run (e.g. the MCP clamping the model's requested
 *  budget to what remains in the session envelope) — it can only narrow, never widen,
 *  because the caller is expected to pass `min(requested, configCeiling)`. */
export interface RunOptions {
  budgetUsdc?: number;
  /**
   * Operator policy for this run (allow/deny domains, per-domain cap, approval
   * threshold, kill-switch). Server/config-supplied, never LLM-controlled — same
   * principle as `budgetUsdc`. Omitted ⇒ `DEFAULT_POLICY` (the original behavior).
   */
  policy?: DecisionPolicy;
  /** Window state for per-domain rate caps across runs (prior pays per host). */
  decideContext?: DecideContext;
  /**
   * Gate this run settles into (base URL). Server/config-supplied, never
   * LLM-controlled — same principle as `budgetUsdc`/`policy`. Lets a hosted caller
   * point one run at a specific fleet tenant's gate. Omitted ⇒ `tollgateBase()`
   * (the env default), so the OSS single-gate path is unchanged.
   */
  tollgateUrl?: string;
  /**
   * This run's custody-free session signer (BUY-4 hosted path). When present, tolls
   * are signed by the injected `MemoSigner` (naulon's grant-checked `/sign-memo` BFF
   * over an encrypted session key) instead of the env `BUYER_PRIVATE_KEY` — so the
   * hosted `naulon_research` pays from the buyer's managed session wallet, mirroring
   * `naulon_pay_and_read`. Omitted ⇒ `selectBuyer()` picks the env buyer (the OSS
   * self-host path). Server/config-supplied, never LLM-controlled. A `MemoSigner`
   * (memo/Arc rail) or a `GatewaySigner` (memo-less Circle rails); `run` routes it to
   * the matching buyer via `supportsMemo(activeNetwork())`, like `selectBuyer()`.
   */
  signer?: MemoSigner | GatewaySigner;
  /**
   * BOTH rail signers over the same sealed session key (RAS-B mixed fleet). When present, the run
   * pays through `railBuyer`, which picks memo vs gateway PER-402 from each tenant's advertised
   * network — exactly like `naulon_pay_and_read` — instead of the fleet-global `supportsMemo`
   * routing a single `signer` gets. Wins over `signer`. Server/config-supplied, never LLM-controlled.
   */
  railSigners?: RailSigners;
  /**
   * This run's held-license backend (BUY-4 hosted path). The cloud injects a
   * per-session store so the composite loop's free re-reads never cross buyer
   * boundaries in a shared process. Omitted ⇒ the process-global file (OSS path).
   */
  heldStore?: HeldStore;
  /**
   * The wallet that signs proof-of-possession for this run's cnf-bound held
   * re-reads. Hosted path injects a signer over the session key (`/sign-pop`);
   * omitted ⇒ `getWallet()` (the env/dev wallet, unchanged OSS path).
   */
  popWallet?: AgentWallet;
}

/**
 * The price-loop origin/domain gate (H-OSS-1 — the SSRF fix). `discover()` is
 * explicitly untrusted (a poisoned catalog/feed candidate can carry ANY `url`), and
 * `buyer.price()` in the loop below is a real network GET — reached BEFORE decide()
 * ever runs an origin check. Mirrors the granular MCP tools' `originRefusal`
 * (wayfarer-mcp/server.ts): `authorizeOrigin` for endpoint identity — OR the
 * operator-stated `allowDomains` boundary, which REPLACES identity rather than
 * stacking with it — then the ONE shared `spendGate` for the price-independent
 * domain policy (deny-list / allow-list). `priceUsdc: 0` because there is no price
 * yet, same reasoning as the MCP's free-probe gate: whatever spendGate would refuse
 * to pay for, this loop must refuse to even price.
 *
 * `killSwitch` is deliberately excluded from the policy handed to `spendGate` here
 * (via a cloned copy) — it is evaluated for REAL, unmodified, inside decide()'s own
 * spendGate call once appraisal has run. `DecisionPolicy.killSwitch` is documented
 * to halt SPEND only ("free re-reads still allowed"), the same carve-out decide()
 * already gives a held-license cache hit. A price probe is a free, unpaid read — not
 * spend — so it stays outside the kill-switch, exactly like a cache re-read. Letting
 * kill-switch drop candidates HERE would silently empty `priced` before appraise/
 * decide ever run, losing the auditable "kill-switch halted this" decision log
 * (BUY-3.3 / BUY-4.4). Deny-list / allow-list / off-gate identity are a DIFFERENT
 * question — "may this origin be reached at all" — and stay fully enforced
 * regardless of kill-switch.
 */
function priceRefusal(candidateUrl: string | undefined, gate: string, slug: string, policy: DecisionPolicy): string | null {
  const target = payUrlOf(candidateUrl, gate, slug);
  if (target === undefined) return `no resolvable pay URL — refusing (the configured gate is ${gate})`;

  const origin = authorizeOrigin({
    target,
    gate,
    ...(policy.allowDomains ? { allowDomains: policy.allowDomains } : {}),
  });
  if (!origin.ok) return origin.refusal;

  const gated = spendGate({
    host: payHostOf(candidateUrl, gate, slug),
    priceUsdc: 0,
    policy: { ...policy, killSwitch: false },
  });
  return gated.ok ? null : gated.reason;
}

export async function run(
  topic: string,
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<RunResult> {
  const cfg = getConfig();
  const budget = opts.budgetUsdc ?? cfg.WAYFARER_BUDGET_USDC;
  const base = opts.tollgateUrl ?? tollgateBase();
  const policy = opts.policy ?? DEFAULT_POLICY;
  // Hosted path: sign each leg via the injected cloud session key (custody-free); the
  // env BUYER_PRIVATE_KEY is never read. Route the injected signer to the active network's
  // rail — memo-LESS networks (Base + every Gateway chain) settle via gatewayBuyer (the Circle
  // envelope), memo networks via memoBuyer — mirroring selectBuyer() and naulon_pay_and_read so
  // hosted research pays from the same wallet on whatever rail the tenant settles on. The cloud
  // injects the signer matching the network's rail. Default: the BYO-key buyer selectBuyer() picks.
  const buyer = opts.railSigners
    ? railBuyer(opts.railSigners)
    : opts.signer
      ? supportsMemo(activeNetwork())
        ? memoBuyer(opts.signer as MemoSigner)
        : gatewayBuyer(opts.signer as GatewaySigner)
      : await selectBuyer();
  // Per-session held store + PoP signer (BUY-4): the injected pair keeps the composite loop's
  // free re-reads isolated per buyer and signed by the paying session EOA. Omitted ⇒ OSS defaults.
  const heldStore: HeldStore = opts.heldStore ?? fileHeldStore;
  const popWallet: AgentWallet = opts.popWallet ?? getWallet();

  log(`topic: "${topic}"`);
  log(`budget: $${budget} · mode ${cfg.PAYMENT_MODE} · wallet ${buyer.address} · gate ${base}`);
  await buyer.init();

  // 1. discover (free teasers)
  const candidates = await discover(topic);
  log(`\ndiscovered ${candidates.length} candidate essays`);

  // 2. price (free x402 probes — no payment yet)
  const priced: PricedCandidate[] = [];
  // The TRUE total (all legs, atomic micro-USDC) each candidate was quoted at here. The pay step
  // uses it as the toll-moved ceiling, so a gate that quotes low at appraisal and charges more at
  // pay time is aborted — the BUY-1.4 guarantee. Budget-remaining alone cannot detect that.
  const quotedTotals = new Map<string, bigint>();
  for (const c of candidates) {
    // SSRF gate (H-OSS-1) — see priceRefusal: refused candidates are dropped here,
    // BEFORE buyer.price() ever reaches the network.
    const refusal = priceRefusal(c.url, base, c.slug, policy);
    if (refusal) {
      log(`  ⛔ ${c.slug}: refusing to price — ${refusal}`);
      continue;
    }
    const quoted = await buyer.price(c.url ?? articleUrl(base, c.slug), "citation");
    if (quoted) {
      priced.push({ ...c, price: usdc(quoted.priceUsdc) });
      quotedTotals.set(c.slug, quotedTotalAtomic(quoted));
    } else log(`  · ${c.slug}: not gated — skipping`);
  }
  log(`priced ${priced.length} gated essays`);

  // 3. appraise
  const appraised: AppraisedCandidate[] = await appraise(topic, priced);
  log(`\nappraisal:`);
  for (const a of appraised) log(`  · ${a.slug}: relevance ${a.relevance.toFixed(2)} — ${a.rationale}`);

  // 4. decide (the agency). A live license already held for an essay makes it a
  // zero-cost "cache" — pay once, re-read free.
  const held = await heldStore.load();
  const nowSec = Math.floor(Date.now() / 1000);
  const licensed = new Set([...held.values()].filter((h) => isLive(h, nowSec)).map((h) => h.slug));
  if (licensed.size) log(`\nholding ${licensed.size} live license(s) — those re-read free`);

  // gateBase lets decide() resolve a slug-only candidate to the SAME url the pay step below uses,
  // so domain policy is evaluated against the host that actually gets paid (never Candidate.host).
  const decisions = decide(appraised, budget, licensed, policy, {
    ...opts.decideContext,
    gateBase: opts.decideContext?.gateBase ?? base,
  });
  log(`\ndecisions:`);
  for (const d of decisions) log(`  [${d.action.toUpperCase()}] ${d.slug} — ${d.reason}`);

  // 5. obtain: pay for new sources (capturing + verifying the license), or re-read
  // already-licensed ones for free.
  const jwks = await fetchJwks(base);
  const sources: Source[] = [];
  let spent = 0;
  for (const d of decisions) {
    const url = d.url ?? articleUrl(base, d.slug);

    if (d.action === "cache") {
      const h = held.get(d.slug);
      if (!h) continue;
      // Holder-of-key license: sign a fresh proof-of-possession so the gate knows
      // we still hold the payer wallet, not just a captured token.
      let proof: string | undefined;
      if (h.pop) {
        proof = (await buildPopProof(h, popWallet, Date.now())) ?? undefined;
        if (!proof) {
          log(`  ✗ re-read ${d.slug}: license is holder-of-key but wallet can't sign — paying instead`);
          continue;
        }
      }
      const reread = await rereadWithLicense(url, "citation", h.jws, buyer.address, proof);
      if (reread.ok) {
        sources.push({ slug: d.slug, title: d.title, content: reread.content ?? "", paidUsdc: 0, licenseId: h.jti });
        log(`  🎫 re-read ${d.slug} FREE with held license (${h.jti.slice(0, 8)})${h.pop ? " 🔑 proof-of-possession" : ""}`);
      } else {
        log(`  ✗ re-read failed for ${d.slug}: ${reread.error}`);
      }
      continue;
    }

    if (d.action !== "pay") continue;
    // The pay-time ceiling is the TIGHTER of two independent bounds:
    //   · toll-moved  — the total this candidate was quoted at in step 2, plus the configured
    //     tolerance. Catches a gate that quotes low at appraisal and charges more at pay time
    //     (a budget check alone cannot: the inflated price still "fits").
    //   · budget      — what is actually left. decide() plans against the AUTHOR-leg price, which
    //     under-counts a fee'd toll, so its plan can exceed budget.
    // Whichever is smaller wins; exceeding it aborts the pay having spent nothing.
    const remainingAtomic = BigInt(Math.max(0, Math.round((budget - spent) * 1_000_000)));
    const quotedAtomic = quotedTotals.get(d.slug);
    const bps = BigInt(cfg.WAYFARER_TOLL_TOLERANCE_BPS);
    const tollCeiling = quotedAtomic === undefined ? undefined : quotedAtomic + (quotedAtomic * bps) / 10_000n;
    const ceiling = tollCeiling === undefined ? remainingAtomic : (tollCeiling < remainingAtomic ? tollCeiling : remainingAtomic);
    const result = await buyer.fetch(url, "citation", { maxTotalAtomic: ceiling.toString() });
    if (!result.ok) {
      log(`  ✗ payment failed for ${d.slug}: ${result.error}`);
      continue;
    }
    // Debit the TRUE total across all legs (costUsdc), not the author leg (paidUsdc) — else a
    // fee'd toll under-counts spend and the loop keeps buying past budget.
    spent += result.costUsdc ?? result.paidUsdc ?? d.price;

    let licenseId: string | undefined;
    if (result.license) {
      const decoded = decodeHeld(result.license);
      const verified = jwks ? verifyAgainst(result.license, jwks) : null;
      if (decoded) {
        // Persist the url actually paid alongside the license, so it travels with the
        // held record (a slug-only re-read can then target the real link, not a template).
        held.set(d.slug, { ...decoded, jws: result.license, url });
        licenseId = decoded.jti;
      }
      const mark =
        verified === true ? " → 🎫 license verified" : verified === false ? " → ⚠ license UNVERIFIED" : " → 🎫 license";
      log(`  ✓ paid $${(result.paidUsdc ?? d.price).toFixed(6)} for ${d.slug} (ref ${result.settlementRef})${mark} ${licenseId?.slice(0, 8) ?? ""}`);
    } else {
      log(`  ✓ paid $${(result.paidUsdc ?? d.price).toFixed(6)} for ${d.slug} (ref ${result.settlementRef})`);
    }

    sources.push({
      slug: d.slug,
      title: d.title,
      content: result.content ?? "",
      paidUsdc: result.paidUsdc ?? d.price,
      settlementRef: result.settlementRef,
      licenseId,
    });
  }
  await heldStore.save(held);

  // 6. ground
  const answer = await ground(topic, sources);
  log(`\nspent $${spent.toFixed(6)} of $${budget} across ${sources.length} cited source(s)`);

  return { topic, budget, spent: usdc(spent), decisions, sources, answer };
}

async function ground(topic: string, sources: Source[]): Promise<string> {
  if (sources.length === 0) {
    return `No sources were worth paying for under budget for "${topic}".`;
  }
  const citations = sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.slug})${s.licenseId ? ` · licensed 🎫 ${s.licenseId.slice(0, 8)}` : ""}`)
    .join("\n");

  if (getConfig().OPENAI_API_KEY) {
    try {
      const { ChatOpenAI } = await import("@langchain/openai");
      const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2 });
      const corpus = sources
        .map((s, i) => `[${i + 1}] ${s.title}\n${s.content.slice(0, 4000)}`)
        .join("\n\n");
      const res = await model.invoke(
        `Answer the topic "${topic}" grounded ONLY in these sources, citing with [n].\n\n${corpus}`,
      );
      return `${String(res.content)}\n\nSources:\n${citations}`;
    } catch {
      // fall through to template
    }
  }
  return (
    `Grounded answer for "${topic}" (template; set OPENAI_API_KEY for synthesis):\n` +
    `Paid for and cited ${sources.length} source(s).\n\nSources:\n${citations}`
  );
}
