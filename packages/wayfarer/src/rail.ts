/**
 * railBuyer — a buyer that settles on whatever chain the TENANT's 402 advertises, not the fleet
 * default. The gate stamps each tenant's rail into the 402 (RAS-B sell side: a gateway network sets
 * extra.name 'GatewayWalletBatched'; a memo network does not). This buyer reads that and signs the
 * matching envelope, so one buyer serves a mixed fleet (an Arc-default fleet with a Base tenant).
 * Both signers wrap the SAME sealed session key (only the EIP-712 domain differs); the cloud injects
 * both. Absent per-tenant divergence the 402 carries the fleet rail, so railBuyer picks the same
 * builder activeNetwork() would have — byte-identical to memoBuyer/gatewayBuyer for a single-rail fleet.
 */
import {
  classifyPaymentError,
  classifySignerRefusal,
  probe,
  type Buyer,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { runPaidFetch } from "./paidFetch.ts";
import { assembleMemoPayment, type MemoSigner } from "./memo.ts";
import { gatewayLegPayload, type BatchingRequirements, type GatewaySigner } from "./gateway.ts";
import { networkByCaip2, supportsMemo } from "@naulon/shared";

export interface RailSigners {
  memo?: MemoSigner;
  gateway?: GatewaySigner;
}

/** Pick the rail the GATE will settle this 402 on — which is now Circle Gateway on EVERY chain.
 *
 *  This used to read `supportsMemo` and sign a raw EIP-3009 authorization for Arc, because the gate
 *  self-relayed Arc through the Memo predeploy. The gate stopped doing that (`verifyAndSettle`):
 *  memo settlement is one on-chain transaction per read at our own gas, which Circle prices out of
 *  the sub-cent band this product sells in. Buyer and gate must agree about the envelope or the
 *  settle fails as "malformed memo payload", so this predicate moves in the SAME commit as that one
 *  and keeps no independent opinion.
 *
 *  It is a function rather than a constant because the fallback still means something: an UNKNOWN
 *  CAIP-2 network is judged by the descriptor `build402` stamps on every gateway-mode 402. A quote
 *  from some future non-Gateway rail would not carry it, and should not be signed as one. */
function isGateway402(quoted: Quoted): boolean {
  if (networkByCaip2(quoted.requirements.network)) return true;
  return (quoted.requirements as BatchingRequirements).extra?.name === "GatewayWalletBatched";
}

/**
 * Sign a 402 the caller already holds, on the rail the GATE will settle it on — the payment
 * builder `railBuyer` runs inside its fetch loop, exposed on its own for a host that never needs
 * the loop: one that built the 402 itself and is now paying it from the buyer's session signers
 * (the cloud selling a licence it just offered). Picking the rail here, once, is what keeps a
 * sale and a toll on the same envelope for the same tenant chain.
 *
 * Throws on a rail with no signer, and lets `gatewayLegPayload` / the signer throw their own
 * coded refusals (N-leg on the Circle SDK, a grant refusal) — the caller owns the mapping.
 */
export async function assembleRailPayment(quoted: Quoted, nowMs: number, signers: RailSigners): Promise<string> {
  if (isGateway402(quoted)) {
    if (!signers.gateway) {
      throw new Error("no gateway signer for a Circle Gateway 402 (this tenant settles on a memo-less chain)");
    }
    return Buffer.from(JSON.stringify(await gatewayEnvelopes(signers.gateway, quoted))).toString("base64");
  }
  if (!signers.memo) {
    throw new Error("no memo signer for a memo-rail 402 (this tenant settles on a memo chain)");
  }
  // Reached only for an UNKNOWN CAIP-2 that also lacks the Gateway descriptor — every chain in the
  // registry settles through Circle now (`isGateway402`). Kept because a caller may still hold a
  // memo signer for a network we do not ship, and silently signing that as a Circle envelope would
  // produce a payment no facilitator can verify.
  const net = networkByCaip2(quoted.requirements.network);
  return assembleMemoPayment(quoted, nowMs, signers.memo, net);
}

/**
 * One Circle envelope per leg the 402 advertised — the multi-leg Gateway payment.
 *
 * ## Why this is a loop and not one SDK call
 *
 * `BatchEvmScheme.createPaymentPayload(x402Version, paymentRequirements)` takes ONE requirement
 * (verified against `@circle-fin/x402-batching` 3.4.0). Signing a two-leg toll with it would
 * authorize the author leg and silently drop the operator fee, so `gatewayLegPayload` refuses a
 * multi-leg quote outright — correctly, as a single-leg builder.
 *
 * That guard used to mean multi-leg tolls were memo-rail-only, which made the operator fee
 * collectable on exactly one chain. It was never an SDK limit on what the RAIL can carry: the gate
 * parses an ARRAY of per-leg payloads (`verifyAndSettle`) and `settleGateway` verifies each leg
 * against its own requirements. So N legs settle fine on Gateway; the buyer simply has to sign N
 * envelopes rather than asking the SDK for one that covers them all.
 *
 * Each leg is signed as its own single-leg quote — same `requirements` with that leg's `payTo` and
 * `amount`, exactly how `build402` assembled them — so `gatewayLegPayload`'s descriptor guard still
 * runs on every one, and its N-leg guard stays meaningful for anyone calling it directly.
 *
 * A single-leg quote returns the bare envelope, not a one-element array: that is the shape stock
 * x402 clients send and the gate still accepts either, so there is no reason to change what the
 * common case puts on the wire.
 */
async function gatewayEnvelopes(signer: GatewaySigner, quoted: Quoted): Promise<unknown> {
  const legs = quoted.legs;
  if (!legs || legs.length <= 1) return gatewayLegPayload(signer, quoted, 2);
  const out: unknown[] = [];
  for (const leg of legs) {
    // Leg order is the contract: the gate pairs payloads[i] with its own legs[i] and refuses on a
    // count mismatch, so this must stay a sequential map over `quoted.legs` and never a filter.
    const legQuote: Quoted = {
      ...quoted,
      amountAtomic: leg.amount,
      requirements: { ...quoted.requirements, payTo: leg.payTo, amount: leg.amount },
      legs: undefined,
    };
    out.push(await gatewayLegPayload(signer, legQuote, 2));
  }
  return out;
}

export function railBuyer(signers: RailSigners): Buyer {
  const address = (signers.memo?.address ?? signers.gateway?.address ?? "0x") as `0x${string}`;
  return {
    address,
    async init() {
      // Injected-signer buyer: no deposit, custody-free (mirrors memoBuyer/gatewayBuyer init).
    },
    price(url, kind): Promise<Quoted | null> {
      return probe(url, kind, address).then((o) => (o.status === "gated" ? o.quoted : null));
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      const buildPayment = (quoted: Quoted, nowMs: number): Promise<string> =>
        assembleRailPayment(quoted, nowMs, signers);
      const onSignError = (error: string): Fetched => {
        // Parity with memoBuyer/gatewayBuyer: a hosted session signer throws a coded refusal
        // (grant exhausted/expired/no session) → typed so the agent can act; any other throw (incl.
        // a "no <rail> signer" config fault) → classifyPaymentError. A socket error never reaches
        // here — the shared loop classifies the paid GET as a rail-agnostic origin_error itself.
        const refusal = classifySignerRefusal(error);
        return refusal
          ? { ok: false, error, ...refusal }
          : { ok: false, error, ...classifyPaymentError(error) };
      };
      return runPaidFetch(url, kind, address, guard, buildPayment, onSignError);
    },
  };
}
