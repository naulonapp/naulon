/**
 * @naulon/wayfarer — public library surface.
 *
 * The autonomous buy-side research agent: discover → quote → appraise → decide →
 * pay → ground, with reusable Citation Licenses (pay once, re-read free). This
 * barrel is the side-effect-free entry the package.json `exports` map points at;
 * the CLI (`./index.ts`) is a thin consumer of it, never the other way round.
 *
 * Stage-name map (buy-side spec → the genuine export):
 *   quote → probePrice (free 402 probe, no spend)
 *   pay   → selectBuyer + the Buyer seam (mock | memo | gateway)
 *   read  → rereadWithLicense (free re-read of a held live license)
 */

// ── pipeline entry ──────────────────────────────────────────────────────────
export { run } from "./agent.ts";
export type { Logger, RunOptions } from "./agent.ts";

// Pipeline primitives a second consumer (the MCP server) reuses to resolve an
// article URL from a slug against the configured gate, and to verify a captured
// license against the gate's JWKS — single-sourced here so the two can't drift.
export { tollgateBase, articleUrl, fetchJwks, verifyAgainst } from "./agent.ts";

// ── discover ────────────────────────────────────────────────────────────────
export { discover } from "./discover.ts";

// ── appraise ────────────────────────────────────────────────────────────────
export { appraise } from "./appraise.ts";

// ── quote + pay (the Buyer seam) ────────────────────────────────────────────
export {
  probePrice,
  assemblePayment,
  rereadWithLicense,
  selectBuyer,
  quotedTotalAtomic,
  tollMovedOrNull,
  classifyPaymentError,
} from "./buyer.ts";
export type { Buyer, Quoted, LegRequirements, Fetched, FetchErrorCode, PayGuard } from "./buyer.ts";
export { mockBuyer } from "./pay.ts";
export { gatewayBuyer } from "./gateway.ts";
export { memoBuyer, signMemoPayment } from "./memo.ts";
export type { MemoSigner } from "./memo.ts";

// ── decide (policy) ─────────────────────────────────────────────────────────
export { decide, DEFAULT_POLICY } from "./decide.ts";
export type { DecisionPolicy, DecideContext } from "./decide.ts";

// ── cross-source allocation (buyer-side citation-reward policy) ──────────────
export { allocateByContribution } from "./allocation.ts";
export type { SourceAllocation } from "./allocation.ts";

// ── citation licenses (pay once, re-read free) ──────────────────────────────
export { decodeHeld, isLive, loadHeld, saveHeld } from "./licenseStore.ts";
export type { HeldLicense } from "./licenseStore.ts";
export { buildPopProof } from "./pop.ts";

// ── wallet ──────────────────────────────────────────────────────────────────
export { getWallet } from "./wallet.ts";
export type { AgentWallet } from "./wallet.ts";

// ── shared domain types ─────────────────────────────────────────────────────
export type {
  Candidate,
  PricedCandidate,
  AppraisedCandidate,
  Action,
  Decision,
  Source,
  RunResult,
} from "./types.ts";
