/**
 * Gateway buyer — the real Circle rail. Wraps @circle-fin/x402-batching's
 * GatewayClient: deposit USDC into the Gateway Wallet once, then pay() each
 * article, which runs the full deposit-backed 402 flow on Arc (gasless, batched,
 * <500ms finality) and settles straight to the author's wallet.
 *
 * Wired to the documented SDK surface (see circlefin/arc-nanopayments/agent.mts).
 * Exercising it live needs a funded BUYER_PRIVATE_KEY on Arc testnet.
 */
import { activeNetwork, getConfig } from "@naulon/shared";
import {
  classifyPaymentError,
  probePrice,
  tollMovedOrNull,
  type Buyer,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";

export function gatewayBuyer(): Buyer {
  const cfg = getConfig();
  if (!cfg.BUYER_PRIVATE_KEY) {
    throw new Error(
      `PAYMENT_MODE=gateway requires BUYER_PRIVATE_KEY (a funded wallet on ${activeNetwork().chainName}).`,
    );
  }
  const privateKey = (
    cfg.BUYER_PRIVATE_KEY.startsWith("0x") ? cfg.BUYER_PRIVATE_KEY : `0x${cfg.BUYER_PRIVATE_KEY}`
  ) as `0x${string}`;

  // Constructed lazily so the SDK only loads in gateway mode.
  let clientPromise: Promise<import("@circle-fin/x402-batching/client").GatewayClient> | null = null;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = import("@circle-fin/x402-batching/client").then(
        ({ GatewayClient }) => new GatewayClient({ chain: activeNetwork().chainName, privateKey }),
      );
    }
    return clientPromise;
  };

  return {
    // The address is derived once the client loads; expose a placeholder until then.
    get address() {
      return cfg.BUYER_ADDRESS ?? "0x";
    },
    async init() {
      const client = await getClient();
      console.log(`  depositing ${cfg.DEPOSIT_AMOUNT_USDC} USDC into the Gateway Wallet...`);
      const result = await client.deposit(cfg.DEPOSIT_AMOUNT_USDC);
      console.log(`  deposit tx ${result.depositTxHash}`);
      const balances = await client.getBalances();
      console.log(`  gateway available: ${balances.gateway.formattedAvailable}`);
    },
    price(url, kind): Promise<Quoted | null> {
      return probePrice(url, kind, cfg.BUYER_ADDRESS ?? "wayfarer");
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      // The Circle SDK's pay() speaks only stock x402 (single `accepts[0]` leg). If the
      // publisher declares extra settlement legs (e.g. an operator fee), the gate
      // advertises naulonLegs and rejects any payment that doesn't sign EVERY leg — so
      // letting pay() sign just the author leg would buy a confusing 402, not content.
      // Refuse loudly and point at the rail that does support N-leg (memo/Arc). Probing
      // here costs one extra request only on the gateway path; gateway N-leg is a
      // documented follow-up (it needs per-leg Circle signing outside pay()).
      const probe = await probePrice(url, kind, cfg.BUYER_ADDRESS ?? "wayfarer");
      // Re-quote at pay time and abort if the toll moved past the authorized ceiling.
      if (probe) {
        const moved = tollMovedOrNull(probe, guard);
        if (moved) return moved;
      }
      if (probe?.legs && probe.legs.length > 1) {
        return {
          ok: false,
          error:
            `gateway (Circle SDK) mode cannot pay a ${probe.legs.length}-leg toll (operator fee): ` +
            `the SDK signs only the author leg. Use the memo (Arc) rail for multi-leg settlement.`,
        };
      }

      // The Circle SDK's pay() parses only the response BODY + the `PAYMENT-RESPONSE`
      // header and drops the rest of the HTTP response, so the gate's `x-naulon-license`
      // receipt header never reaches PayResult (which is {data,amount,formattedAmount,
      // transaction,status} — no headers). The SDK exposes no response hook either
      // (GatewayClientConfig is {chain,privateKey,rpcUrl}). Its one seam is the ambient
      // global `fetch` it calls for the paid 200 — so wrap it for the duration of this
      // one pay() to sniff the license off that response, then restore it. Safe because
      // the agent pays one article at a time (no concurrent pay() to race the global).
      const client = await getClient();
      let captured: string | undefined;
      const realFetch = globalThis.fetch;
      const sniffing: typeof globalThis.fetch = async (input, init) => {
        const res = await realFetch(input, init);
        const lic = res.headers.get("x-naulon-license");
        if (lic) captured = lic;
        return res;
      };
      globalThis.fetch = sniffing;
      try {
        const result = await client.pay<unknown>(url, {
          method: "GET",
          headers: { "x-naulon-kind": kind, "x-naulon-agent": client.address },
        });
        return {
          ok: true,
          content: typeof result.data === "string" ? result.data : JSON.stringify(result.data),
          paidUsdc: parseFloat(result.formattedAmount),
          settlementRef: result.transaction,
          license: captured,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error, ...classifyPaymentError(error) };
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
}
