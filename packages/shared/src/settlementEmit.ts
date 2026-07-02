/**
 * naulon → publisher settlement emit (the producer side of wire #3).
 *
 * After an x402 paid read settles on-chain, naulon reports it to the publisher's
 * earnings ledger: POST ${ORIGIN_URL}/api/credits/settlement, HMAC-signed. The
 * publisher's ledger is canonical; its author dashboard reads from these events,
 * never from scraping chain balance. The request shape + signature recipe are
 * specified by `buildSettlementBody` / `signSettlement` below.
 *
 * This module is PURE: it maps an AttributedEvent into the publisher's request shape and
 * signs it. No fetch, no ambient clock — the caller passes the timestamp and
 * owns delivery/retry (tollgate/src/settlementSink.ts). That keeps the money
 * math and the signature recipe unit-testable offline.
 */
import { primaryPayee, type TieBreak } from "./attribution.ts";
import { splitMicro } from "./attribution.ts";
import type { AttributedEvent, WalletAddress } from "./types.ts";
import { signSettlement, type SettlementBody, type SettlementSplit } from "@naulon/sdk";

// The settlement WIRE CONTRACT (the body shape + the HMAC signer) now lives in
// @naulon/sdk — the verify side (verifySettlement) mirrors it from the same
// source. Re-exported so existing `@naulon/shared` importers are unchanged.
// `buildSettlementBody` below stays here: it consumes the gate-internal
// AttributedEvent + attribution math, which are not contract surface.
export { signSettlement };
export type { SettlementBody, SettlementSplit, SignedSettlement } from "@naulon/sdk";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const MICRO = 1_000_000;

/**
 * Map a settled AttributedEvent into IA's settlement shape.
 *
 * Invariants this guarantees (IA rejects a violation):
 *  - Σ splits[].amount === grossAmount   (dust-free, via splitMicro)
 *  - exactly one split is `primary: true`, and it is the on-chain recipient
 *    (the largest-share payee — mirrors x402.ts `primaryPayee`)
 *  - eventId === event.id (the stable, persisted UUID / license jti) so an
 *    at-least-once retry carries the same id and IA dedupes it.
 */
export function buildSettlementBody(
  event: AttributedEvent,
  chainId: number,
  tieBreak: TieBreak = "wallet",
): SettlementBody {
  const grossMicro = Math.round(event.amount * MICRO);
  const allocations = splitMicro(grossMicro, event.payees);

  // The on-chain leg pays the largest-share payee; that same wallet is `paidTo`
  // and the one split flagged primary. Uses the shared `primaryPayee` chooser so
  // this record names exactly the wallet x402's requirement builder paid — same
  // tie-break, single source of truth.
  const primaryWallet = event.payees.length ? primaryPayee(event.payees, tieBreak) : undefined;

  const splits: SettlementSplit[] = allocations.map((a, i) => ({
    authorId: a.authorId,
    wallet: a.wallet,
    amount: String(a.micro),
    weight: Math.round((event.payees[i]?.share ?? 0) * 1000),
    ...(a.wallet === primaryWallet ? ({ primary: true } as const) : {}),
  }));

  const payer =
    event.payerAddress && event.payerAddress !== ZERO_ADDRESS ? event.payerAddress : null;

  return {
    eventId: event.id,
    slug: event.slug,
    txHash: event.settlementRef,
    chainId,
    currency: "USDC",
    grossAmount: String(grossMicro),
    paidTo: (primaryWallet ?? ZERO_ADDRESS) as WalletAddress,
    payer,
    settledAt: new Date(event.at).toISOString(),
    splits,
  };
}

