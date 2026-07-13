/**
 * The settlement tail — the side-effecting half that runs AFTER `decide()` says a
 * machine presented a payment. Verifies + settles the buyer→author payment
 * (custody-free), builds the attributed event, mints the re-read license, and
 * best-effort persists + reports it.
 *
 * Extracted so BOTH consumers share one code path:
 *   - the gate's `createApp` reverse proxy (the fleet-proxied toll), and
 *   - the hosted `POST /_naulon/verify` the in-app SDK middleware calls (the
 *     self-host-enforcement toll — the agent's own IP hits the origin).
 *
 * Custody-free: `verifyAndSettle` moves money buyer→author directly; this never
 * pools or holds USDC. Idempotent on `event.id`; a ledger/emit hiccup never costs
 * the agent its receipt (money already moved), so both are best-effort.
 */
import { randomUUID } from "node:crypto";
import {
  activeNetwork,
  getConfig,
  mintLicense,
  networkByCaip2,
  usdc,
  walletAddress,
  type AttributedEvent,
  type PublisherConfig,
} from "@naulon/shared";
import { licensing, type Quote, type SettlementLegReq } from "@naulon/enforce";
import { record } from "./eventLog.ts";
import { emitSettlement } from "./settlementSink.ts";
import { verifyAndSettle } from "./x402.ts";

const cfg = getConfig();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SettleResult {
  ok: boolean;
  /** Set on failure — the x402 verify/settle error (drop the caller to a 402). */
  error?: string;
  settlementRef?: string;
  /** The resolved payer wallet (a real 0x… address, else undefined). */
  payer?: string;
  /** The x402 `PAYMENT-RESPONSE` header value to echo back to the buyer. */
  responseHeader?: string;
  /** The minted Citation License (re-read entitlement); absent for a zero-address payer. */
  licenseJws?: string;
}

export interface SettleArgs {
  payment: string;
  legs: SettlementLegReq[];
  quote: Quote;
  publisher: PublisherConfig;
  /** Single timestamp shared with the advertised 402 (build402) — pass decide()'s `now`. */
  now: number;
}

export async function settleAndAttribute(args: SettleArgs): Promise<SettleResult> {
  const { payment, legs, quote: q, publisher, now } = args;

  const result = await verifyAndSettle(payment, legs, now, publisher.id);
  if (!result.ok) return { ok: false, error: result.error };

  // Paid. Resolve the chain this settled on from the author leg the 402 advertised
  // (per-tenant), falling back to the fleet default — so the license + the earnings
  // settlement both name the chain the money actually moved on, not a global.
  const settleNet = networkByCaip2(legs[0]?.requirements.network ?? "") ?? activeNetwork();
  const licenseNetwork = {
    chainId: settleNet.chainId,
    usdc: settleNet.usdc,
    gateway: settleNet.gatewayWallet,
  };

  // Build the attributed event (full recursive split).
  const payerResolved = /^0x[0-9a-fA-F]{40}$/.test(result.payer ?? "") ? result.payer! : ZERO_ADDRESS;
  const event: AttributedEvent = {
    // Full UUID — this is also the license `jti`. A sliced/derived id risks a
    // collision that would make the supabase ignore-duplicates path silently drop
    // a second paid event and make /licenses/:jti return the wrong one.
    id: randomUUID(),
    // Attribute the event to the resolved publisher (the default resolver's id is
    // "default"). A single optional tag; the single-tenant drain never reads it.
    publisherId: publisher.id,
    slug: q.slug,
    kind: q.kind,
    amount: usdc(q.price),
    payees: q.payees,
    payerAddress: walletAddress(payerResolved),
    settlementRef: result.settlementRef ?? "unknown",
    // Stamp the settle chain so a later drain re-sends on the same chain (survives
    // a multi-network fleet). Absent on pre-per-tenant events ⇒ activeNetwork().
    chainId: settleNet.chainId,
    at: now,
  };

  // Mint the receipt from the IN-MEMORY event, before persisting — money has
  // already moved, so a ledger hiccup must never cost the agent its license or turn
  // a paid request into a 402. Skip minting only when we couldn't resolve a real
  // payer (a zero-address bearer token would be unscoped).
  let licenseJws: string | undefined;
  if (licensing && payerResolved !== ZERO_ADDRESS) {
    licenseJws = mintLicense(
      {
        event,
        issuer: publisher.licenseIdentity,
        audience: publisher.licenseIdentity,
        ttlSeconds: cfg.LICENSE_TTL_SECONDS,
        payeesMode: cfg.LICENSE_PAYEES_MODE,
        tieBreak: cfg.PRIMARY_PAYEE_TIEBREAK,
        title: q.title,
        network: licenseNetwork,
        // Holder-of-key: bind to the (already non-zero) payer wallet so re-reads
        // need a proof-of-possession. Off → a v1 bearer license, demo unchanged.
        popBindAddress: cfg.LICENSE_POP ? payerResolved : undefined,
      },
      licensing.key,
      now,
    );
  }

  // Persist best-effort. A failure here is logged, never surfaced to the agent
  // (it already paid and holds a valid receipt).
  await record(event).catch((err: unknown) => {
    console.error("[tollgate] ledger write failed (payment already settled on-chain):", err);
  });

  // Report the settlement to the publisher's earnings ledger (wire #3). Fire and
  // forget — never delay the agent's content on the publisher's RTT; the background
  // drain guarantees eventual delivery if this attempt misses. Dark without the
  // publisher's settlement secret; idempotent on event.id; never throws.
  void emitSettlement(event, publisher.settlementSecret, publisher.originUrl).catch((err: unknown) => {
    console.error("[tollgate] settlement emit threw (payment already settled):", err);
  });

  return {
    ok: true,
    settlementRef: result.settlementRef,
    payer: payerResolved === ZERO_ADDRESS ? result.payer : payerResolved,
    responseHeader: result.responseHeader,
    licenseJws,
  };
}
