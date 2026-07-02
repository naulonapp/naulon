/**
 * Offline conformance helper. A publisher feeds the output into THEIR own receiver
 * in THEIR test harness and asserts a 200 + a written payout — proving their
 * integration without ever POSTing to production (there is no dry-run path; a
 * money receiver gets no public "pretend" mode). The CLI prints this fixture.
 */
import { signSettlement } from "./sign.ts";
import type { SettlementBody } from "../contract/settlement.ts";

/** A valid sample body (Σ splits === gross, exactly one primary) — passes settlementBodySchema. */
const SAMPLE_BODY: SettlementBody = {
  eventId: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  txHash: "0xfeed",
  chainId: 5042002,
  currency: "USDC",
  grossAmount: "5000",
  paidTo: "0x1111111111111111111111111111111111111111" as SettlementBody["paidTo"],
  payer: "0x3333333333333333333333333333333333333333" as SettlementBody["paidTo"],
  settledAt: "2023-11-14T22:13:20.000Z",
  splits: [
    {
      authorId: "mira",
      wallet: "0x1111111111111111111111111111111111111111" as SettlementBody["paidTo"],
      amount: "5000",
      weight: 1000,
      primary: true,
    },
  ],
};

export function makeSignedSettlementFixture(opts: {
  secret: string;
  body?: SettlementBody;
  now?: number;
}): { rawBody: string; headers: { "x-naulon-timestamp": string; "x-naulon-signature": string } } {
  const body = opts.body ?? SAMPLE_BODY;
  const rawBody = JSON.stringify(body);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { timestamp, signature } = signSettlement(rawBody, opts.secret, now);
  return {
    rawBody,
    headers: { "x-naulon-timestamp": timestamp, "x-naulon-signature": signature },
  };
}
