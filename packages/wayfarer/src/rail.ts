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

/** Pick the rail the GATE will settle this 402 on. Registry first: a known CAIP-2 network uses the
 *  same predicate the gate's verifyAndSettle uses (`supportsMemo` — memo self-relay vs Circle
 *  Gateway), so buyer and gate can never disagree. The `extra.name 'GatewayWalletBatched'` tell is
 *  only the fallback for a network we don't know: build402 stamps that descriptor on EVERY
 *  gateway-mode 402 — memo chains included — so on a known memo network it is noise, not a signal
 *  (trusting it signed the Gateway envelope against Arc's memo settle: "malformed memo payload"). */
function isGateway402(quoted: Quoted): boolean {
  const net = networkByCaip2(quoted.requirements.network);
  if (net) return !supportsMemo(net);
  return (quoted.requirements as BatchingRequirements).extra?.name === "GatewayWalletBatched";
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
      const buildPayment = async (quoted: Quoted, nowMs: number): Promise<string> => {
        if (isGateway402(quoted)) {
          if (!signers.gateway) {
            throw new Error("no gateway signer for a Circle Gateway 402 (this tenant settles on a memo-less chain)");
          }
          // gatewayLegPayload owns the N-leg + GatewayWalletBatched guards, so the mixed-fleet
          // rail gets the same loud, actionable refusals gatewayBuyer gives (it previously had
          // neither, silently dropping extra legs until the gate rejected on leg-count mismatch).
          const payload = await gatewayLegPayload(signers.gateway, quoted, 2);
          return Buffer.from(JSON.stringify(payload)).toString("base64");
        }
        if (!signers.memo) {
          throw new Error("no memo signer for a memo-rail 402 (this tenant settles on a memo chain)");
        }
        // Resolve the memo chain from the 402's advertised network so a non-fleet memo chain signs
        // against the right USDC domain (registry: memo = arcTestnet today, but keep it honest). An
        // unknown CAIP-2 falls back to activeNetwork() inside assembleMemoPayment (undefined triggers the
        // default). A multi-leg toll signed by a batch-capable injected signer reserves atomically here;
        // a single leg or a batch-less signer takes the per-leg path — same framing either way.
        const net = networkByCaip2(quoted.requirements.network);
        return assembleMemoPayment(quoted, nowMs, signers.memo, net);
      };
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
