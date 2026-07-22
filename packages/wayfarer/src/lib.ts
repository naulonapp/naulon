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
// article URL from a slug against the configured gate, to derive the gate's
// canonical license identity from a paid-into URL, and to verify a captured
// license against the gate's JWKS — single-sourced here so the two can't drift.
export { tollgateBase, articleUrl, fetchJwks, verifyAgainst, licenseIdentityFor } from "./agent.ts";

// ── discover ────────────────────────────────────────────────────────────────
export { discover } from "./discover.ts";
export { resolvedDiscoverySourceUrl } from "./discovery.ts";

// ── appraise ────────────────────────────────────────────────────────────────
export { appraise } from "./appraise.ts";

// ── quote + pay (the Buyer seam) ────────────────────────────────────────────
export {
  probe,
  probePrice,
  probeFailure,
  assemblePayment,
  rereadWithLicense,
  selectBuyer,
  quotedTotalAtomic,
  tollMovedOrNull,
  classifyPaymentError,
} from "./buyer.ts";
export type { Buyer, Quoted, LegRequirements, Fetched, FetchErrorCode, PayGuard, ProbeOutcome } from "./buyer.ts";
export { mockBuyer } from "./pay.ts";
export {
  gatewayBuyer,
  gatewayDeposit,
  gatewayBalances,
  gatewayTransferStatus,
  gatewayTransfers,
  classifyGatewaySettlement,
} from "./gateway.ts";
export type { GatewaySigner, GatewayDepositOpts, GatewaySettlementState } from "./gateway.ts";
export { memoBuyer, signMemoPayment, assembleMemoPayment } from "./memo.ts";
export type { MemoSigner, MemoTypedData } from "./memo.ts";
export { railBuyer } from "./rail.ts";
export type { RailSigners } from "./rail.ts";

// ── decide (policy) ─────────────────────────────────────────────────────────
export { decide, DEFAULT_POLICY, payHostOf, spendGate } from "./decide.ts";
export type { DecisionPolicy, DecideContext, SpendVerdict } from "./decide.ts";

// ── origin policy (whose origin may money touch) ─────────────────────────────
// The one answer to that question; `spendGate` above stays the one answer to "how
// much". `PayableTarget` is mintable only by `authorizeOrigin`, so a pay path that
// skips the check fails to typecheck rather than failing in production.
export { authorizeOrigin } from "./origin-policy.ts";
export type { OriginRequest, OriginVerdict, PayableTarget } from "./origin-policy.ts";

// ── cross-source allocation (buyer-side citation-reward policy) ──────────────
export { allocateByContribution } from "./allocation.ts";
export type { SourceAllocation } from "./allocation.ts";

// ── citation licenses (pay once, re-read free) ──────────────────────────────
export { decodeHeld, fileHeldStore, isLive, loadHeld, memoryHeldStore, saveHeld } from "./licenseStore.ts";
export type { HeldLicense, HeldStore } from "./licenseStore.ts";
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
