/**
 * Mock buyer — exercises the full x402 protocol offline. It speaks the same
 * header contract as a real client (probe → PAYMENT-REQUIRED → payment-signature
 * → PAYMENT-RESPONSE), but signs a simple offline signature the mock tollgate
 * accepts, so the whole loop runs with no chain, wallet, or Circle access.
 */
import { agentFetch } from "./sign.ts";
import { getWallet } from "./wallet.ts";
import {
  AGENT_UA,
  assemblePayment,
  classifyPaymentError,
  payeeRefusedOrNull,
  probe,
  probeFailure,
  probePrice,
  quotedTotalAtomic,
  tollMovedOrNull,
  type Buyer,
  type Fetched,
  type PayGuard,
  type Quoted,
} from "./buyer.ts";

export function mockBuyer(): Buyer {
  const wallet = getWallet();
  return {
    address: wallet.address,
    async init() {
      /* nothing to fund offline */
    },
    price(url, kind): Promise<Quoted | null> {
      return probePrice(url, kind, wallet.address);
    },
    async fetch(url, kind, guard?: PayGuard): Promise<Fetched> {
      const outcome = await probe(url, kind, wallet.address);
      if (outcome.status !== "gated") return probeFailure(outcome, url);
      const quoted = outcome.quoted;
      // Re-quote at pay time and abort if the toll moved past the authorized ceiling.
      const moved = tollMovedOrNull(quoted, guard);
      if (moved) return moved;
      // Payee identity: refuse a payTo no owner authorized, before signing (parity with runPaidFetch).
      const refused = await payeeRefusedOrNull(quoted, guard);
      if (refused) return refused;
      // One offline signature per advertised leg (operator fee → 2-leg array); a stock
      // single-author quote stays the bare object assemblePayment emits for one leg.
      const paymentSignature = await assemblePayment(quoted, (req, nonce) => ({
        payer: wallet.address,
        amount: req.amount,
        nonce,
      }));
      const res = await agentFetch(url, {
        headers: {
          "user-agent": AGENT_UA,
          "x-naulon-agent": wallet.address,
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
      // Mirror paidFetch: a body-read throw after the 200 is settlement-ambiguous, not a
      // safe retry. costUsdc carries the true total (all legs) for correct budget debit.
      let content: string;
      try {
        content = await res.text();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          errorCode: "settlement_ambiguous",
          retryable: false,
          error: `paid read: payment sent but reading the response body failed (${error}). Do NOT blind-retry.`,
        };
      }
      const costUsdc = Number(quotedTotalAtomic(quoted)) / 1_000_000;
      return { ok: true, content, settlementRef, paidUsdc: quoted.priceUsdc, costUsdc, license };
    },
  };
}
