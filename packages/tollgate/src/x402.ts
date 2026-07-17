/**
 * x402 flow, seller SETTLE side — wired to the real Circle Gateway batching
 * contract. The BUILD side (the 402 challenge assembly) is `@naulon/enforce`'s
 * `build402.ts`; this module verifies + settles the buyer's signature.
 *
 * Protocol (matches @circle-fin/x402-batching + circlefin/arc-nanopayments):
 *   - 402 response carries a base64 `PAYMENT-REQUIRED` header naming the price,
 *     the Arc network/USDC, the payTo author, and the GatewayWallet `extra`.
 *   - The agent retries with a base64 `payment-signature` header.
 *   - We verify + settle it. In gateway mode that's Circle's BatchFacilitatorClient
 *     (gasless, batched, settles buyer-deposit → payTo directly — custody-free,
 *     we never hold funds). In mock mode it clears offline for local demos.
 *
 * payTo is ONE address per x402 payment (the primary author). The recursive
 * co-author split is recorded on the event and reconciled by the attribution
 * service's onward payouts — see packages/attribution.
 */
import { createHash } from "node:crypto";
import {
  activeNetwork,
  getConfig,
  networkByCaip2,
  relayerKeyFor,
  supportsMemo,
  type MemoAuthorization,
  type SettlementNetwork,
} from "@naulon/shared";
import {
  preverifyEip3009,
  relayerAddress,
  settleViaMemo,
  signMemoAuthorization,
  toMemoData,
  toMemoId,
} from "./arcRelay.ts";
import { getPendingLegSink, type PendingLeg, type PendingLegSink } from "./pendingLegs.ts";
// The x402 BUILD side now lives in @naulon/enforce (the runtime-agnostic kernel);
// this module is the SETTLE side and consumes the build-side primitives from there.
import {
  bindingOf,
  consumeNonce,
  MAX_TIMEOUT_SECONDS,
  type PaymentRequirements,
  type SettlementLegReq,
} from "@naulon/enforce";
// Re-export the build-side public surface so `@naulon/tollgate`'s entry (app.ts)
// and existing `./x402.ts` importers keep the same symbols without a second path.
export {
  build402,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "@naulon/enforce";
export type { PaymentRequirements, SettlementLegReq } from "@naulon/enforce";

const cfg = getConfig();

export interface LegSettlement {
  payTo: string;
  amount: string;
  /** Settlement ref once this leg settles; undefined while authorized-but-unsettled. */
  settlementRef?: string;
  /** True once on-chain (or mock) settled; false = buyer-authorized, awaiting the drain. */
  settled: boolean;
}

export interface VerifyResult {
  ok: boolean;
  payer?: string;
  settlementRef?: string;
  responseHeader?: string;
  error?: string;
  /** Per-leg settlement outcomes (author first), present on a successful N-leg settle. */
  legSettlements?: LegSettlement[];
}

// Lazily construct the real facilitator only in gateway mode.
type FacilitatorClient = {
  verify: (p: unknown, r: unknown) => Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle: (p: unknown, r: unknown) => Promise<{ success: boolean; errorReason?: string; payer?: string; transaction?: string }>;
};
// Keyed by facilitator URL + which key — a multi-network fleet spans the testnet AND
// mainnet facilitators AND holds two bearers, so a single global client would settle a
// base tenant against the testnet endpoint (or with the wrong key). One client per
// (endpoint, bearer), built once.
const facilitators = new Map<string, Promise<FacilitatorClient>>();

/** The facilitator bearer for a network: test key on testnet, live key on mainnet.
 *  Circle's key split is by environment, not chain. Testnet falls back to the live key
 *  when CIRCLE_API_KEY_TESTNET is unset (and the testnet facilitator also works keyless).
 *  Reads config live on every call (not the module's frozen `cfg` snapshot) so a
 *  `resetConfig()` mid-process is observed immediately — see the direct unit test.
 *  Exported for the branch test; getFacilitator uses it. */
export function facilitatorBearer(net: SettlementNetwork): string | undefined {
  const c = getConfig();
  return net.testnet ? (c.CIRCLE_API_KEY_TESTNET ?? c.CIRCLE_API_KEY) : c.CIRCLE_API_KEY;
}

async function getFacilitator(net: SettlementNetwork = activeNetwork()): Promise<FacilitatorClient> {
  // GATEWAY_API_URL pins every network to one endpoint (a test/self-host override);
  // otherwise the endpoint follows the resolved network (testnet vs mainnet).
  const url = cfg.GATEWAY_API_URL ?? net.gatewayApiUrl;
  const bearer = facilitatorBearer(net);
  // Arc mainnet is a private preview: Gateway API calls need the preview header until GA.
  const arcPreview = net.chainName === "arc";
  const cacheKey = `${url}|${bearer ?? ""}|${arcPreview ? "arc" : ""}`;
  let promise = facilitators.get(cacheKey);
  if (!promise) {
    promise = import("@circle-fin/x402-batching/server").then(({ BatchFacilitatorClient }) => {
      // The testnet facilitator works keyless (see circlefin/arc-nanopayments).
      // A bearer is optional — when set we thread it through as a bearer token
      // (useful for rate limits / a custom GATEWAY_API_URL).
      const config: Record<string, unknown> = { url };
      const headers: Record<string, string> = {};
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      if (arcPreview) headers["X-ARC-PRIVATE-MAINNET-ENABLED"] = "true";
      if (Object.keys(headers).length > 0) {
        config.createAuthHeaders = async () => ({ verify: headers, settle: headers, supported: headers });
      }
      return new BatchFacilitatorClient(config) as unknown as FacilitatorClient;
    });
    facilitators.set(cacheKey, promise);
  }
  return promise;
}

/**
 * Verify a payment-signature and settle it. Single-leg (the stock case) or N-leg
 * (a publisher with extra legs). `legs` is the author requirement alone (today's
 * callers) or the full per-leg list from `build402` (leg 0 = author).
 *
 * N-leg protocol: verify EVERY leg first — any invalid → 402, settle NOTHING (no
 * partial charge). Then settle the author (leg 0) synchronously: it gates the
 * content, and its failure is the only one that turns the read back into a 402.
 * Extra legs are buyer-authorized; they settle best-effort here and a failure is
 * recorded unsettled (never a 402 — the author was paid, content served) for a
 * future drain to retry idempotently within `validBefore`.
 */
export async function verifyAndSettle(
  paymentSignature: string,
  legs: PaymentRequirements | PaymentRequirements[] | SettlementLegReq[],
  now: number,
  publisherId?: string,
): Promise<VerifyResult> {
  const legReqs = normalizeLegs(legs);
  if (legReqs.length === 0) return { ok: false, error: "no settlement legs" };

  // Multi-leg payers send an ARRAY of per-leg payloads (leg order); a single-leg
  // payer sends today's bare object — treat it as a one-element array (back-compat).
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(paymentSignature, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed payment-signature" };
  }
  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  if (payloads.length !== legReqs.length) {
    return { ok: false, error: `leg count mismatch: ${payloads.length} signed, ${legReqs.length} required` };
  }
  const pairs: LegPair[] = legReqs.map((leg, i) => ({
    role: leg.role,
    requirements: leg.requirements,
    payload: payloads[i],
  }));

  if (cfg.PAYMENT_MODE !== "gateway") return settleMock(pairs, now, publisherId);
  // Resolve the settle chain from the AUTHOR leg the 402 advertised (per-tenant),
  // not the process-global — so a base tenant settles on base even when the fleet
  // default is Arc. Fallback to activeNetwork() keeps the single-tenant path exact.
  const net = networkByCaip2(legReqs[0]!.requirements.network) ?? activeNetwork();
  // On a memo-capable network (Arc) the buyer signs a RAW USDC EIP-3009 authorization
  // and we self-relay it through the Memo predeploy — Circle's facilitator can't verify
  // that domain. Field-presence gate, never a chainName check (see supportsMemo): a
  // memo-less leg (Base) falls through to the stock Gateway path with no edit here.
  return supportsMemo(net)
    ? settleMemo(pairs, net, now, publisherId)
    : settleGateway(pairs, net, now, publisherId);
}

/** Memo-network settlement: pre-verify every leg's raw EIP-3009 authorization, then
 *  self-relay the author leg through the Arc Memo predeploy (emitting the indexed Memo)
 *  and DEFER the rest to the drain (which relays them too). Mirrors `settleGateway`'s
 *  N-leg protocol (verify all → settle author sync → defer extras), but the rail is the
 *  relayer EOA, not Circle's facilitator. Custody-free: the inner transfer is the
 *  buyer's authorization; the relayer only pays gas. */
async function settleMemo(pairs: LegPair[], net: SettlementNetwork, now: number, publisherId?: string): Promise<VerifyResult> {
  if (!supportsMemo(net)) return { ok: false, error: `network ${net.chainName} has no Memo predeploy` };
  const relayerKey = relayerKeyFor(net);
  if (!relayerKey) {
    return { ok: false, error: net.testnet
      ? "RELAYER_PRIVATE_KEY required for memo-network settlement"
      : "RELAYER_PRIVATE_KEY_MAINNET required for mainnet memo-network settlement" };
  }
  const key = (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`;
  const relayer = await relayerAddress(key);

  // Verify EVERY leg first — any invalid → 402, settle nothing (no partial charge).
  const parsed: { auth: MemoAuthorization; signature: `0x${string}`; req: PaymentRequirements }[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const payload = p.payload as { authorization?: MemoAuthorization; signature?: `0x${string}` };
    if (!payload?.authorization || !payload?.signature) {
      return { ok: false, error: `leg ${i}: malformed memo payload (need {authorization, signature})` };
    }
    const { authorization: auth, signature } = payload;
    // The buyer must have signed THIS leg's recipient and amount — else a valid sig for
    // some other transfer could be replayed against this leg.
    if (auth.to.toLowerCase() !== p.requirements.payTo.toLowerCase() || auth.value !== p.requirements.amount) {
      return { ok: false, error: `leg ${i}: authorization (to ${auth.to}, value ${auth.value}) != requirements (payTo ${p.requirements.payTo}, amount ${p.requirements.amount})` };
    }
    const pre = await preverifyEip3009(auth, signature, net, now, cfg.USDC_EIP712_NAME);
    if (!pre.ok) return { ok: false, error: `leg ${i} (${p.requirements.payTo}): ${pre.reason}` };
    parsed.push({ auth, signature, req: p.requirements });
  }

  // Author leg (0) settles synchronously through the Memo predeploy and gates content.
  const author = parsed[0]!;
  const memoId = await toMemoId(author.req.memoId ?? author.auth.nonce);
  const memoData = await toMemoData(`naulon:${publisherId ?? "default"}:${author.req.memoId ?? author.req.payTo}`);
  const authorSettle = await settleViaMemo({
    net,
    auth: author.auth,
    signature: author.signature,
    payTo: author.req.payTo,
    relayerAddress: relayer,
    memoId,
    memoData,
    nowMs: now,
    usdcNameOverride: cfg.USDC_EIP712_NAME,
  });
  if (!authorSettle.success) {
    return { ok: false, error: `author leg settle failed: ${authorSettle.errorReason ?? "settlement failed"}` };
  }
  const legSettlements: LegSettlement[] = [
    { payTo: author.req.payTo, amount: author.req.amount, settlementRef: authorSettle.transaction, settled: true },
  ];

  // Extra legs: buyer-authorized, settlement DEFERRED to the drain (which relays them on
  // a memo network too). Same shape as the gateway path — no partial-failure window.
  await deferExtraLegs(pairs, now, publisherId, legSettlements);

  const payer = authorSettle.payer ?? author.auth.from;
  const responseHeader = Buffer.from(
    JSON.stringify({ success: true, transaction: authorSettle.transaction, network: author.req.network, payer }),
  ).toString("base64");
  return { ok: true, payer, settlementRef: authorSettle.transaction, responseHeader, legSettlements };
}

/** Accept either the full per-leg list from `build402` (with roles — today's gate path)
 *  or a bare requirement / requirement array (legacy callers + tests). A requirement is
 *  wrapped as `{role: author|leg, requirements}`; leg 0 is always the author. */
function normalizeLegs(
  legs: PaymentRequirements | PaymentRequirements[] | SettlementLegReq[],
): SettlementLegReq[] {
  const arr = Array.isArray(legs) ? legs : [legs];
  return arr.map((l, i) =>
    "requirements" in l ? l : { role: i === 0 ? "author" : "leg", requirements: l },
  );
}

type LegPair = { role: string; requirements: PaymentRequirements; payload: unknown };

/** Mock ref for a settled leg — deterministic from its requirements. */
function mockRef(r: PaymentRequirements): string {
  return `mock-${r.payTo.slice(2, 10)}-${r.amount}`;
}

/** Gateway mode: verify all legs against the real facilitator, then settle the author
 *  synchronously and DEFER the rest to the drain (O5). */
async function settleGateway(pairs: LegPair[], net: SettlementNetwork, now: number, publisherId?: string): Promise<VerifyResult> {
  const facilitator = await getFacilitator(net);
  // Verify EVERY leg first.
  const payers: (string | undefined)[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { requirements, payload } = pairs[i]!;
    const v = await facilitator.verify(payload, requirements);
    if (!v.isValid) {
      return { ok: false, error: `leg ${i} (${requirements.payTo}): ${v.invalidReason ?? "verification failed"}` };
    }
    payers.push(v.payer);
  }

  // Author leg (0) settles synchronously and gates content.
  const author = pairs[0]!;
  const authorSettle = await facilitator.settle(author.payload, author.requirements);
  if (!authorSettle.success) {
    return { ok: false, error: `author leg settle failed: ${authorSettle.errorReason ?? "settlement failed"}` };
  }
  const legSettlements: LegSettlement[] = [
    { payTo: author.requirements.payTo, amount: author.requirements.amount, settlementRef: authorSettle.transaction, settled: true },
  ];

  // Extra legs: buyer-authorized here, settlement DEFERRED. Persist the signed
  // authorization; `drainPendingLegs` settles it on-chain within `validBefore`,
  // batched and idempotently (O1/O5). No partial-failure window — only the author leg
  // is synchronous, so a leg can never fail "after the author was paid".
  await deferExtraLegs(pairs, now, publisherId, legSettlements);

  const payer = authorSettle.payer ?? payers[0] ?? "unknown";
  const responseHeader = Buffer.from(
    JSON.stringify({ success: true, transaction: authorSettle.transaction, network: author.requirements.network, payer }),
  ).toString("base64");
  return { ok: true, payer, settlementRef: authorSettle.transaction, responseHeader, legSettlements };
}

/** Mock mode: offline { payer, amount, nonce } per leg. Verify all (no mutation),
 *  then consume nonces author-first so a bad leg never spends an earlier leg's nonce. */
async function settleMock(pairs: LegPair[], now: number, publisherId?: string): Promise<VerifyResult> {
  const mocks: { payer: string; nonce: string }[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { requirements, payload } = pairs[i]!;
    const m = (payload ?? {}) as { payer?: string; amount?: string; nonce?: string };
    if (!m.payer) return { ok: false, error: `leg ${i}: missing payer` };
    if (m.amount === undefined || BigInt(m.amount) < BigInt(requirements.amount)) {
      return { ok: false, error: `leg ${i}: insufficient payment amount` };
    }
    if (!m.nonce) return { ok: false, error: `leg ${i}: missing nonce` };
    mocks.push({ payer: m.payer, nonce: m.nonce });
  }

  // Settle pass — author nonce first (the replay guard for the leg that gates
  // content). A full replay is rejected here without re-spending anything.
  const author = pairs[0]!;
  const authorConsume = await consumeNonce(mocks[0]!.nonce, bindingOf(author.requirements), now);
  if (!authorConsume.ok) return { ok: false, error: authorConsume.error };
  const legSettlements: LegSettlement[] = [
    { payTo: author.requirements.payTo, amount: author.requirements.amount, settlementRef: mockRef(author.requirements), settled: true },
  ];

  // Extra legs: buyer-authorized here, settlement DEFERRED to the drain (which consumes
  // each leg's nonce then). Same model as gateway — the author leg is the only
  // synchronous one, so there is no partial-failure window. O1 idempotency is the
  // drain's atomic `markSettled`.
  await deferExtraLegs(pairs, now, publisherId, legSettlements);

  const payer = mocks[0]!.payer;
  const responseHeader = Buffer.from(
    JSON.stringify({ success: true, transaction: mockRef(author.requirements), network: author.requirements.network, payer }),
  ).toString("base64");
  return { ok: true, payer, settlementRef: mockRef(author.requirements), responseHeader, legSettlements };
}

/** Persist each extra leg (1..N) as a buyer-authorized PENDING leg for the deferred drain,
 *  and push a `settled:false` entry. Idempotent on the leg's authorization id, so a buyer
 *  retry of the same quote never double-records. Shared by gateway + mock. */
async function deferExtraLegs(
  pairs: LegPair[],
  now: number,
  publisherId: string | undefined,
  legSettlements: LegSettlement[],
): Promise<void> {
  if (pairs.length <= 1) return;
  const sink: PendingLegSink = getPendingLegSink();
  for (let i = 1; i < pairs.length; i++) {
    const { role, requirements, payload } = pairs[i]!;
    const leg: PendingLeg = {
      id: legAuthId(payload),
      publisherId,
      role,
      payTo: requirements.payTo,
      amount: requirements.amount,
      payload,
      requirements,
      validBefore: legValidBefore(payload, now),
      at: now,
    };
    try {
      await sink.record(leg);
    } catch (err) {
      console.error(`[tollgate] failed to record pending leg ${i} (${requirements.payTo}):`, err);
    }
    legSettlements.push({ payTo: requirements.payTo, amount: requirements.amount, settled: false });
  }
}

/** The leg's settlement identity = its EIP-3009 nonce (mock: `payload.nonce`; gateway:
 *  `payload.payload.authorization.nonce`). Unique + the on-chain replay key, so it doubles
 *  as the idempotency key. Falls back to a content hash if no nonce is present. */
function legAuthId(payload: unknown): string {
  const p = payload as { nonce?: string; payload?: { authorization?: { nonce?: string } } };
  const nonce = p?.nonce ?? p?.payload?.authorization?.nonce;
  if (typeof nonce === "string" && nonce.length > 0) return nonce;
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/** When the buyer's authorization expires (epoch ms). Gateway reads the EIP-3009
 *  `validBefore` (unix seconds → ms); mock/unknown synthesizes from the advertised window.
 *  The drain MUST settle before this or the leg is lost (the buyer is never charged late). */
function legValidBefore(payload: unknown, now: number): number {
  const vb = (payload as { payload?: { authorization?: { validBefore?: string | number } } })
    ?.payload?.authorization?.validBefore;
  const n = Number(vb);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // seconds vs ms heuristic
  return now + MAX_TIMEOUT_SECONDS * 1000;
}

/** Settle ONE pending leg via the active mode. Returns the settlement ref on success,
 *  undefined on failure (the leg stays pending for the next pass). */
async function settleOneLeg(leg: PendingLeg, now: number): Promise<string | undefined> {
  if (cfg.PAYMENT_MODE === "gateway") {
    // Resolve from the leg's OWN advertised network so a deferred re-settle lands on
    // the chain it was authorized for, even across a multi-network fleet.
    const net = networkByCaip2(leg.requirements.network) ?? activeNetwork();
    // Memo network: the pending leg's payload is a raw EIP-3009 authorization, not a
    // Gateway one — relay it through the Memo predeploy (same primitive as the sync
    // author leg). Field-presence gated, so a Base deploy never reaches this branch.
    if (supportsMemo(net)) return relayPendingLeg(leg, net, now);
    try {
      const facilitator = await getFacilitator(net);
      const s = await facilitator.settle(leg.payload, leg.requirements);
      if (!s.success) console.error(`[tollgate] pending leg ${leg.id} (${leg.payTo}) settle failed: ${s.errorReason}`);
      return s.success ? s.transaction : undefined;
    } catch (err) {
      console.error(`[tollgate] pending leg ${leg.id} (${leg.payTo}) settle threw:`, err);
      return undefined;
    }
  }
  // Mock: consume the leg's own nonce now (the deferred equivalent of the gate's inline
  // consume). A replayed/expired nonce → not settled, stays pending.
  const nonce = (leg.payload as { nonce?: string })?.nonce;
  if (!nonce) return undefined;
  const c = await consumeNonce(nonce, bindingOf(leg.requirements), now);
  return c.ok ? mockRef(leg.requirements) : undefined;
}

/** Relay a deferred leg through the Arc Memo predeploy (the drain's memo-network path).
 *  Idempotency stays the drain's job (markSettled compare-and-set); on-chain the buyer's
 *  EIP-3009 nonce prevents a double charge regardless. */
async function relayPendingLeg(
  leg: PendingLeg,
  net: ReturnType<typeof activeNetwork>,
  now: number,
): Promise<string | undefined> {
  const relayerKey = relayerKeyFor(net);
  if (!relayerKey) {
    const msg = net.testnet
      ? "RELAYER_PRIVATE_KEY required for memo settlement"
      : "RELAYER_PRIVATE_KEY_MAINNET required for mainnet memo settlement";
    console.error(`[tollgate] pending leg ${leg.id}: ${msg}`);
    return undefined;
  }
  const payload = leg.payload as { authorization?: MemoAuthorization; signature?: `0x${string}` };
  if (!payload?.authorization || !payload?.signature) {
    console.error(`[tollgate] pending leg ${leg.id} (${leg.payTo}): malformed memo payload`);
    return undefined;
  }
  const key = (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`;
  const relayer = await relayerAddress(key);
  const memoId = await toMemoId(leg.requirements.memoId ?? payload.authorization.nonce);
  const memoData = await toMemoData(leg.requirements.memoId ?? `naulon:${leg.payTo}`);
  const r = await settleViaMemo({
    net,
    auth: payload.authorization,
    signature: payload.signature,
    payTo: leg.requirements.payTo,
    relayerAddress: relayer,
    memoId,
    memoData,
    nowMs: now,
    usdcNameOverride: cfg.USDC_EIP712_NAME,
  });
  if (!r.success) console.error(`[tollgate] pending leg ${leg.id} (${leg.payTo}) relay failed: ${r.errorReason}`);
  return r.success ? r.transaction : undefined;
}

/** Scope for a pending-leg drain pass. `publisherId` drains one publisher's legs only (the
 *  multi-tenant fleet path); omitted drains every pending leg (single-tenant). */
export interface DrainLegScope {
  publisherId?: string;
}

/** Outcome of a drain pass. `settled` = legs cleared this pass; `failed` = attempted but
 *  the settle didn't land (stay pending, retried next pass). Expired legs (past
 *  `validBefore`) are not attempted — they fall out of the pending set. */
export interface DrainLegResult {
  settled: number;
  failed: number;
}

/**
 * Settle buyer-authorized extra legs still inside their validity window (O5). Idempotent
 * (O1): `markSettled` is an atomic compare-and-set, so two concurrent drains (or a drain
 * racing a retry) settle a leg exactly once. Custody-free: every settle moves the buyer's
 * own EIP-3009 authorization buyer→payTo directly; the gate never holds funds.
 */
export async function drainPendingLegs(
  scope: DrainLegScope = {},
  now: number = Date.now(),
): Promise<DrainLegResult> {
  const sink = getPendingLegSink();
  const legs = await sink.pending(now, scope.publisherId);
  let settled = 0;
  let failed = 0;
  for (const leg of legs) {
    const ref = await settleOneLeg(leg, now);
    if (!ref) {
      failed += 1;
      continue;
    }
    // Atomic: only the call that flips unsettled→settled counts. A concurrent drain that
    // settled the same authorization loses here (→ false) and isn't double-counted; the
    // on-chain nonce/deposit prevents a double charge regardless.
    if (await sink.markSettled(leg.id, ref)) settled += 1;
  }
  return { settled, failed };
}

/** Build a mock payment-signature (used by the offline wayfarer + tests). */
export function buildMockSignature(payer: string, amountAtomic: string, nonce?: string): string {
  return Buffer.from(JSON.stringify({ payer, amount: amountAtomic, nonce })).toString("base64");
}

/**
 * Build a memo-network payment-signature: a raw USDC EIP-3009 authorization signed
 * against the USDC EIP-712 domain (the Arc self-relay rail). The buyer counterpart to
 * `buildGatewaySignature` — same `{authorization, signature}` wire shape, different
 * signing domain (USDC token, not the GatewayWallet). The memo id is NOT signed (the
 * relayer attaches it at submit), so the buyer needs nothing extra. Use ONLY when the
 * active network is memo-capable; on Base, use `buildGatewaySignature`.
 */
export async function buildMemoSignature(
  privateKey: `0x${string}`,
  requirements: PaymentRequirements,
  nowMs: number = Date.now(),
): Promise<string> {
  const payload = await memoLegPayload(privateKey, requirements, nowMs);
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Multi-leg memo buyer: one EIP-3009 authorization per leg (leg order), assembled into
 *  the ARRAY shape `verifyAndSettle` parses for an N-leg quote. */
export async function buildMemoSignatures(
  privateKey: `0x${string}`,
  legRequirements: PaymentRequirements[],
  nowMs: number = Date.now(),
): Promise<string> {
  const payloads = await Promise.all(legRequirements.map((r) => memoLegPayload(privateKey, r, nowMs)));
  return Buffer.from(JSON.stringify(payloads)).toString("base64");
}

/** The per-leg memo payload `{ authorization, signature }` — signs the leg's payTo +
 *  amount against the active network's USDC domain. */
async function memoLegPayload(
  privateKey: `0x${string}`,
  requirements: PaymentRequirements,
  nowMs: number,
): Promise<{ authorization: MemoAuthorization; signature: `0x${string}` }> {
  return signMemoAuthorization({
    privateKey,
    // Sign against the chain the requirement names (per-tenant), not a global — so a
    // buyer signing a leg for one tenant's chain signs the right USDC domain.
    net: networkByCaip2(requirements.network) ?? activeNetwork(),
    payTo: requirements.payTo as `0x${string}`,
    amountAtomic: requirements.amount,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    nowMs,
    usdcNameOverride: cfg.USDC_EIP712_NAME,
  });
}

/**
 * Build a REAL Circle Gateway payment-signature (gateway mode) by EIP-712-signing
 * an EIP-3009 authorization with `privateKey`. The gateway counterpart to
 * `buildMockSignature`: where that emits an offline `{ payer, amount, nonce }`,
 * this produces the exact header shape Circle's facilitator `verify` requires —
 * `{ x402Version, payload: { authorization, signature }, resource, accepted }`.
 * A mock-shaped signature sent to the real facilitator is rejected 400
 * (`x402Version/resource/accepted/payload: Required`); this closes that gap and
 * gives the gateway settle path its first end-to-end-shaped buyer.
 *
 * It wraps the SDK's `BatchEvmScheme` rather than re-rolling the EIP-712 domain /
 * validity-window clamp, so the signed shape can never drift from the rail we
 * settle against — the same drift `/rail-review` guards. (The SDK clamps the
 * signed window up to `GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS` = 604900, so the
 * authorization always clears the 7-day floor even if `requirements` advertised
 * less.)
 *
 * `requirements` must be a Gateway batching option — `extra.name`
 * "GatewayWalletBatched", `extra.version` "1", `extra.verifyingContract` set —
 * i.e. exactly what `build402` emits in gateway mode. `resource` is the `resource`
 * object from the 402's PAYMENT-REQUIRED header. SDK + viem are imported lazily so
 * the mock path never loads them.
 */
export async function buildGatewaySignature(
  privateKey: `0x${string}`,
  requirements: PaymentRequirements,
  resource: unknown,
  x402Version = 2,
): Promise<string> {
  const payload = await gatewayLegPayload(privateKey, requirements, resource, x402Version);
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Multi-leg gateway buyer: sign one authorization per leg (leg order) and assemble
 * the ARRAY shape `verifyAndSettle` parses for an N-leg quote. This is "multi-sign
 * = `buildGatewaySignature` once per leg" — each leg is an independent EIP-3009
 * authorization (its own payTo/amount/nonce), never an atomic multi-transfer.
 * Pass `build402(...).legs.map((l) => l.requirements)` as `legRequirements`.
 */
export async function buildGatewaySignatures(
  privateKey: `0x${string}`,
  legRequirements: PaymentRequirements[],
  resource: unknown,
  x402Version = 2,
): Promise<string> {
  const payloads = await Promise.all(
    legRequirements.map((r) => gatewayLegPayload(privateKey, r, resource, x402Version)),
  );
  return Buffer.from(JSON.stringify(payloads)).toString("base64");
}

/** The per-leg gateway payload object — `{ x402Version, payload, resource, accepted }`,
 *  the exact shape Circle's `verify` requires. Wraps the SDK's `BatchEvmScheme` so the
 *  signed shape / validity clamp can never drift from the rail. SDK + viem lazy so the
 *  mock path never loads them. */
async function gatewayLegPayload(
  privateKey: `0x${string}`,
  requirements: PaymentRequirements,
  resource: unknown,
  x402Version: number,
): Promise<Record<string, unknown>> {
  const [{ BatchEvmScheme }, { privateKeyToAccount }] = await Promise.all([
    import("@circle-fin/x402-batching/client"),
    import("viem/accounts"),
  ]);
  const scheme = new BatchEvmScheme(privateKeyToAccount(privateKey));
  const signed = await scheme.createPaymentPayload(x402Version, requirements);
  // The signed payload plus resource + accepted requirements — the assembly the SDK
  // client's pay() does before sending.
  return { ...signed, resource, accepted: requirements };
}
