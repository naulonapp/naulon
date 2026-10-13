/**
 * A refused payment answered with what to do next, not only the facilitator's words. The closed
 * failure set is `@naulon/shared`'s `PaymentFailureReason`; each reason maps to an x402 v2 §9 error
 * code and one remedy sentence that names the network the toll actually settles on.
 *
 * The raw facilitator string is kept as `detail`, because the buyer is entitled to it and a debugger
 * relies on it. It is bounded and flattened to one line: it is third-party text of any length, and
 * it lands in a body with a size budget and in a markdown rendering.
 */
import type { PaymentFailureReason } from "@naulon/shared";
import type { AgentGuide } from "./agentGuide.ts";

/** Cap on `detail`. Facilitator errors are a line or two; anything longer is noise or a dump. */
export const FAILURE_DETAIL_MAX = 500;

export interface PaymentFailureDetail {
  code: PaymentFailureReason;
  /** The x402 v2 §9 code nearest to `code`, for a client that already switches on those. */
  x402Code: string;
  remedy: string;
  detail: string;
}

const X402_CODE: Record<PaymentFailureReason, string> = {
  insufficient_funds: "insufficient_funds",
  authorization_invalid: "invalid_payload",
  malformed_payment: "invalid_payload",
  network_unsupported: "invalid_network",
  settlement_failed: "unexpected_settle_error",
};

function boundedDetail(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= FAILURE_DETAIL_MAX ? flat : `${flat.slice(0, FAILURE_DETAIL_MAX - 1)}…`;
}

export function paymentFailureDetail(reason: PaymentFailureReason, raw: string, guide: AgentGuide): PaymentFailureDetail {
  const { price, network } = guide.howToPay;
  const fund = guide.howToPay.steps.find((s) => s.id === "fund");
  const deposit = fund?.contract ? `the Gateway Wallet ${fund.contract}` : "the Gateway Wallet";
  const remedy: Record<PaymentFailureReason, string> = {
    insufficient_funds: fund
      ? `Your Circle Gateway balance on ${network.name} does not cover ${price}. Deposit USDC to ${deposit} on ${network.name}, wait for it to credit, then retry.`
      : `Your USDC balance on ${network.name} does not cover ${price}. Fund the payer, then retry.`,
    authorization_invalid: `The signature does not match the offer. Sign accepts[0] from the latest PAYMENT-REQUIRED header exactly as given (payTo, amount, network ${network.caip}) and retry inside its validity window.`,
    malformed_payment:
      "The PAYMENT-SIGNATURE header could not be read. Send base64 JSON: one signed object, or an array with one entry per naulonLegs leg, in order.",
    network_unsupported: `This toll settles on ${network.name} (${network.caip}) only. Sign for that network and retry.`,
    settlement_failed: `Settlement failed for a reason the gate does not recognise. Retry once; if it fails again, see ${guide.links.guide}.`,
  };
  return { code: reason, x402Code: X402_CODE[reason], remedy: remedy[reason], detail: boundedDetail(raw) };
}
