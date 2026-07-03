/**
 * The Wayfarer pipeline: discover → price → appraise → decide → pay → ground.
 *
 * Each stage is explicit and logged, so the agent's reasoning is auditable — the
 * decision log is the artifact, not a black box. Paying runs against the
 * tollgate over the real x402 contract; the Buyer is mock (offline) or Circle
 * Gateway (PAYMENT_MODE=gateway), chosen at startup.
 */
import { getConfig, usdc, verifyLicense, type JwkSet } from "@naulon/shared";
import { appraise } from "./appraise.ts";
import { rereadWithLicense, selectBuyer } from "./buyer.ts";
import { memoBuyer, type MemoSigner } from "./memo.ts";
import { decide, DEFAULT_POLICY } from "./decide.ts";
import type { DecideContext, DecisionPolicy } from "./decide.ts";
import { discover } from "./discover.ts";
import { decodeHeld, isLive, loadHeld, saveHeld } from "./licenseStore.ts";
import { buildPopProof } from "./pop.ts";
import { agentFetch } from "./sign.ts";
import type { AppraisedCandidate, PricedCandidate, RunResult, Source } from "./types.ts";
import { getWallet } from "./wallet.ts";

export type Logger = (line: string) => void;

export function tollgateBase(): string {
  const cfg = getConfig();
  return cfg.TOLLGATE_URL ?? `http://localhost:${cfg.TOLLGATE_PORT}`;
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
   * self-host path). Server/config-supplied, never LLM-controlled.
   */
  signer?: MemoSigner;
}

export async function run(
  topic: string,
  log: Logger = () => {},
  opts: RunOptions = {},
): Promise<RunResult> {
  const cfg = getConfig();
  const budget = opts.budgetUsdc ?? cfg.WAYFARER_BUDGET_USDC;
  const base = opts.tollgateUrl ?? tollgateBase();
  // Hosted path: sign each leg via the injected cloud session key (custody-free); the
  // env BUYER_PRIVATE_KEY is never read. Default: the BYO-key buyer selectBuyer() picks.
  // Mirrors naulon_pay_and_read's selection so hosted research pays from the same wallet.
  const buyer = opts.signer ? memoBuyer(opts.signer) : await selectBuyer();

  log(`topic: "${topic}"`);
  log(`budget: $${budget} · mode ${cfg.PAYMENT_MODE} · wallet ${buyer.address} · gate ${base}`);
  await buyer.init();

  // 1. discover (free teasers)
  const candidates = await discover(topic);
  log(`\ndiscovered ${candidates.length} candidate essays`);

  // 2. price (free x402 probes — no payment yet)
  const priced: PricedCandidate[] = [];
  for (const c of candidates) {
    const quoted = await buyer.price(articleUrl(base, c.slug), "citation");
    if (quoted) priced.push({ ...c, price: usdc(quoted.priceUsdc) });
    else log(`  · ${c.slug}: not gated — skipping`);
  }
  log(`priced ${priced.length} gated essays`);

  // 3. appraise
  const appraised: AppraisedCandidate[] = await appraise(topic, priced);
  log(`\nappraisal:`);
  for (const a of appraised) log(`  · ${a.slug}: relevance ${a.relevance.toFixed(2)} — ${a.rationale}`);

  // 4. decide (the agency). A live license already held for an essay makes it a
  // zero-cost "cache" — pay once, re-read free.
  const held = await loadHeld();
  const nowSec = Math.floor(Date.now() / 1000);
  const licensed = new Set([...held.values()].filter((h) => isLive(h, nowSec)).map((h) => h.slug));
  if (licensed.size) log(`\nholding ${licensed.size} live license(s) — those re-read free`);

  const decisions = decide(appraised, budget, licensed, opts.policy ?? DEFAULT_POLICY, opts.decideContext);
  log(`\ndecisions:`);
  for (const d of decisions) log(`  [${d.action.toUpperCase()}] ${d.slug} — ${d.reason}`);

  // 5. obtain: pay for new sources (capturing + verifying the license), or re-read
  // already-licensed ones for free.
  const jwks = await fetchJwks(base);
  const sources: Source[] = [];
  let spent = 0;
  for (const d of decisions) {
    const url = articleUrl(base, d.slug);

    if (d.action === "cache") {
      const h = held.get(d.slug);
      if (!h) continue;
      // Holder-of-key license: sign a fresh proof-of-possession so the gate knows
      // we still hold the payer wallet, not just a captured token.
      let proof: string | undefined;
      if (h.pop) {
        proof = (await buildPopProof(h, getWallet(), Date.now())) ?? undefined;
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
    const result = await buyer.fetch(url, "citation");
    if (!result.ok) {
      log(`  ✗ payment failed for ${d.slug}: ${result.error}`);
      continue;
    }
    spent += result.paidUsdc ?? d.price;

    let licenseId: string | undefined;
    if (result.license) {
      const decoded = decodeHeld(result.license);
      const verified = jwks ? verifyAgainst(result.license, jwks) : null;
      if (decoded) {
        held.set(d.slug, { ...decoded, jws: result.license });
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
  await saveHeld(held);

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
