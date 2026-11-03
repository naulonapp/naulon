/**
 * The x402 `PAYMENT-RESPONSE` header: the gate's receipt for a settled payment, base64 JSON.
 *
 * One owner for both ends of the wire. The gate writes it through `encodePaymentResponse` and every
 * buyer reads it through `decodePaymentResponse`, so a change to the shape cannot leave a buyer
 * reading a settled payment as unsettled.
 */

export interface PaymentReceipt {
  success: true;
  /** Absent when the settle answered without one; the receipt still says it settled. */
  transaction?: string;
  network: string;
  payer: string;
}

export function encodePaymentResponse(receipt: Omit<PaymentReceipt, "success">): string {
  const body: PaymentReceipt = { success: true, ...receipt };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

/**
 * The receipt a header carries, or null when it says nothing was settled. A receipt counts when it
 * says `success: true`, or when it carries a transaction and does not say `success: false`. An
 * empty object, unreadable base64 or JSON that is not an object is no receipt.
 */
export function decodePaymentResponse(raw: string | null | undefined): { transaction?: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { success, transaction } = parsed as { success?: unknown; transaction?: unknown };
  const ref = typeof transaction === "string" && transaction !== "" ? transaction : undefined;
  if (success === false) return null;
  if (success !== true && ref === undefined) return null;
  return ref === undefined ? {} : { transaction: ref };
}
