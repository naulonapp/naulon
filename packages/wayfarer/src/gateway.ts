/**
 * Gateway buyer — the memo-LESS Circle rail (Base + every other Gateway chain). Where the
 * memo rail (memo.ts) relays a raw USDC EIP-3009 authorization, the gateway rail signs an
 * EIP-3009 authorization against the Circle **GatewayWallet** contract (the `extra.
 * verifyingContract` the gate advertises) and posts the full x402 envelope `{x402Version,
 * payload:{authorization,signature}, resource, accepted}` as `payment-signature` — the shape
 * Circle's facilitator `verify` requires (a bare/mock shape is rejected 400
 * `x402Version/resource/accepted/payload: Required` — the Base-settle bug this path fixes).
 *
 * Custody-free seam (mirrors `memoBuyer(MemoSigner)`): a cloud host injects a sign-only
 * `GatewaySigner` (its address + a `signTypedData` that signs the GatewayWallet-domain typed
 * data elsewhere — a grant-checked BFF holding the encrypted session key), so the private key
 * never lives in this process. A viem `PrivateKeyAccount` satisfies the same shape, keeping
 * the CLI/self-host path (env `BUYER_PRIVATE_KEY`) symmetric. The signing wraps the SDK's
 * `BatchEvmScheme` so the signed shape / validity clamp can never drift from the rail (the
 * same reason the gate's own `gatewayLegPayload` does — see tollgate/src/x402.ts).
 *
 * The Gateway balance is funded out-of-band (a one-time deposit into Circle's non-custodial
 * Gateway Wallet); the pay path here is pure sign-only. On the env/CLI path `init()` still
 * deposits via the SDK `GatewayClient` for backwards compatibility.
 */
import { type TypedDataDomain } from "viem";
import { activeNetwork, getConfig } from "@naulon/shared";
import {
  AGENT_UA,
  classifyPaymentError,
  probe,
  probeFailure,
  tollMovedOrNull,
  type Buyer,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";
import { agentFetch } from "./sign.ts";

/**
 * The gateway signer seam — the structural twin of `MemoSigner` and of the SDK's own
 * `BatchEvmSigner` (which the package doesn't re-export). A viem `PrivateKeyAccount` and a
 * cloud in-process session signer both satisfy it. The signed typed data is a
 * `TransferWithAuthorization` against the **GatewayWallet** EIP-712 domain (name
 * "GatewayWalletBatched", version "1", `verifyingContract` from the 402's `extra`) — NOT the
 * USDC token domain the memo rail uses.
 */
export interface GatewaySigner {
  address: `0x${string}`;
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/** The 402's author accept, with the Gateway batching `extra` the envelope needs. `probe`
 *  keeps the runtime object verbatim on `quoted.requirements`; the type there is narrowed to
 *  the common fields, so the gateway rail casts to reach `extra.verifyingContract`. */
type BatchingRequirements = Quoted["requirements"] & {
  scheme?: string;
  extra?: { name?: string; version?: string; verifyingContract?: `0x${string}` };
};

function envAccountKey(): `0x${string}` {
  const cfg = getConfig();
  if (!cfg.BUYER_PRIVATE_KEY) {
    throw new Error(
      `PAYMENT_MODE=gateway on ${activeNetwork().chainName} requires an injected signer or a funded ` +
        `BUYER_PRIVATE_KEY (a wallet whose USDC is deposited in the Circle Gateway Wallet).`,
    );
  }
  return (cfg.BUYER_PRIVATE_KEY.startsWith("0x") ? cfg.BUYER_PRIVATE_KEY : `0x${cfg.BUYER_PRIVATE_KEY}`) as `0x${string}`;
}

/** Sign one Gateway leg's EIP-3009 authorization against the GatewayWallet domain and return
 *  the full envelope `{x402Version, payload, resource, accepted}` — exactly the gate's
 *  `gatewayLegPayload` shape. Wraps the SDK's `BatchEvmScheme` so the domain / validity clamp
 *  never drifts from the rail. SDK loaded lazily so the mock path never pulls it in. */
async function gatewayLegPayload(
  signer: GatewaySigner,
  requirements: BatchingRequirements,
  resource: unknown,
  x402Version: number,
): Promise<Record<string, unknown>> {
  const { BatchEvmScheme } = await import("@circle-fin/x402-batching/client");
  const scheme = new BatchEvmScheme(signer);
  const signed = await scheme.createPaymentPayload(x402Version, requirements as never);
  return { ...signed, resource, accepted: requirements };
}

export function gatewayBuyer(signer?: GatewaySigner): Buyer {
  const cfg = getConfig();
  // Resolve the signer once. An injected signer NEVER reads BUYER_PRIVATE_KEY (the whole point
  // of the cloud wallet — the key lives in the grant-checked BFF, not this process).
  let resolved: GatewaySigner | null = signer ?? null;
  const getSigner = async (): Promise<GatewaySigner> => {
    if (resolved) return resolved;
    const { privateKeyToAccount } = await import("viem/accounts");
    return (resolved = privateKeyToAccount(envAccountKey()));
  };
  const fallbackAddress = signer ? signer.address : ((cfg.BUYER_ADDRESS as `0x${string}` | undefined) ?? "0x");

  return {
    get address() {
      return resolved?.address ?? fallbackAddress;
    },
    async init() {
      // Custody-free out-of-band deposit: the Gateway balance is funded separately, so the
      // injected-signer (cloud) path is a no-op. The env/CLI path keeps the SDK deposit for
      // backwards compatibility — it needs the raw key, which only exists on that path.
      if (signer) return;
      const { GatewayClient } = await import("@circle-fin/x402-batching/client");
      const client = new GatewayClient({ chain: activeNetwork().chainName, privateKey: envAccountKey() });
      console.log(`  depositing ${cfg.DEPOSIT_AMOUNT_USDC} USDC into the Gateway Wallet...`);
      const result = await client.deposit(cfg.DEPOSIT_AMOUNT_USDC);
      console.log(`  deposit tx ${result.depositTxHash}`);
    },
    price(url, kind): Promise<Quoted | null> {
      return probe(url, kind, this.address).then((o) => (o.status === "gated" ? o.quoted : null));
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      const outcome = await probe(url, kind, this.address);
      if (outcome.status !== "gated") return probeFailure(outcome, url);
      const quoted = outcome.quoted;
      // Re-quote at pay time and abort if the toll moved past the authorized ceiling.
      const moved = tollMovedOrNull(quoted, guard);
      if (moved) return moved;
      // The Circle SDK's batched pay signs ONE leg. An N-leg (operator-fee) quote would be
      // silently underpaid — refuse loudly and point at the memo rail (N-leg-capable). Gateway
      // N-leg is a documented follow-up (per-leg signing outside a single createPaymentPayload).
      if (quoted.legs && quoted.legs.length > 1) {
        return {
          ok: false,
          error:
            `gateway (Circle SDK) mode cannot pay a ${quoted.legs.length}-leg toll (operator fee): ` +
            `the SDK signs only the author leg. Use the memo (Arc) rail for multi-leg settlement.`,
        };
      }
      const requirements = quoted.requirements as BatchingRequirements;
      if (requirements.extra?.name !== "GatewayWalletBatched") {
        return {
          ok: false,
          error:
            "gateway mode expects a Circle Gateway batching option (extra.name 'GatewayWalletBatched'); " +
            "the gate advertised a non-gateway 402. Check PAYMENT_MODE / the settlement network.",
        };
      }
      let paymentSignature: string;
      try {
        const payload = await gatewayLegPayload(await getSigner(), requirements, quoted.resource, 2);
        paymentSignature = Buffer.from(JSON.stringify(payload)).toString("base64");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error, ...classifyPaymentError(error) };
      }
      const res = await agentFetch(url, {
        headers: {
          "user-agent": AGENT_UA,
          "x-naulon-agent": this.address,
          "x-naulon-kind": kind,
          "payment-signature": paymentSignature,
        },
      });
      if (res.status === 402) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const error = body.error ?? "payment rejected";
        return { ok: false, error, ...classifyPaymentError(error) };
      }
      if (!res.ok) return { ok: false, error: `origin returned ${res.status}`, errorCode: "origin_error", retryable: true };
      let settlementRef: string | undefined;
      const respHeader = res.headers.get("payment-response");
      if (respHeader) {
        try {
          settlementRef = (JSON.parse(Buffer.from(respHeader, "base64").toString("utf8")) as {
            transaction?: string;
          }).transaction;
        } catch {
          /* ignore */
        }
      }
      const license = res.headers.get("x-naulon-license") ?? undefined;
      return { ok: true, content: await res.text(), settlementRef, paidUsdc: quoted.priceUsdc, license };
    },
  };
}
