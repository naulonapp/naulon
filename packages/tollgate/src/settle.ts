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
  type ForgoneLeg,
  type LicenceFacts,
  type PublisherConfig,
} from "@naulon/shared";
import { licensing, type Quote, type SettlementLegReq } from "@naulon/enforce";
import { record } from "./eventLog.ts";
import { emitSettlementWebhook } from "./webhookSink.ts";
import { verifyAndSettle } from "./x402.ts";

const cfg = getConfig();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SettleResult {
  ok: boolean;
  /** Set on failure — the x402 verify/settle error (drop the caller to a 402). */
  error?: string;
  /** Set on failure — `verify` when nothing was broadcast, `settle` when the author leg's relay
   *  failed. Carried verbatim from `verifyAndSettle`; see `VerifyResult.stage`. */
  stage?: "verify" | "settle";
  settlementRef?: string;
  /** The resolved payer wallet (a real 0x… address, else undefined). */
  payer?: string;
  /** The x402 `PAYMENT-RESPONSE` header value to echo back to the buyer. */
  responseHeader?: string;
  /** The minted Citation License (re-read entitlement); absent for a zero-address payer. */
  licenseJws?: string;
  /**
   * The attributed event's id — which is also the minted licence's `jti`.
   *
   * Returned so a caller that has to key its OWN record by the licence — a control plane built on
   * this core keys a sale row by the jti, so a verifier resolves one from the other — does not
   * have to base64-decode the token it was just handed. Reading an id out of an unverified JWS is
   * a habit worth not starting, even on a token we minted a line earlier.
   *
   * Always set on a successful settle, including when licensing is off and no token was minted.
   */
  eventId?: string;
  /**
   * Legs this buyer was asked for and never authorized (the stock-payer path, naulon#73).
   * Booked onto the ledger row here; also returned so the CALLER can tell the buyer the truth —
   * `crawler-charged` is what money moved, and for a stock payer that is the ask minus this.
   * Absent on every normal settle.
   */
  forgoneLegs?: ForgoneLeg[];
}

export interface SettleArgs {
  payment: string;
  legs: SettlementLegReq[];
  quote: Quote;
  publisher: PublisherConfig;
  /**
   * The Host this toll was collected on — stamped onto the `AttributedEvent`.
   *
   * REQUIRED, unlike the event field it feeds. The field is optional so historical rows stay
   * valid; the argument is required because a caller cannot settle without knowing which host it
   * just tolled, and an optional one would let a caller silently write host-less rows that no
   * downstream reader can repair. Both call sites (the gate's proxy handler and the hosted
   * `/verify`) have it in scope already.
   */
  host: string;
  /** Single timestamp shared with the advertised 402 (build402) — pass decide()'s `now`. */
  now: number;
  /**
   * A licence SALE rather than a toll.
   *
   * A toll is one payment for one slug, made AFTER a read, and mints the short-window access
   * licence this gate has always minted — that is what `licence` being absent means, and the
   * minted token is then byte-identical to before this field existed.
   *
   * A sale is one payment for a SCOPE and a PERIOD, made BEFORE any read. The money path is
   * identical (the same verify, the same buyer→author legs, the same custody-free rule), so it
   * settles through here rather than through a second implementation; the only difference is
   * what the minted claim says. These four fields are the difference, and they are handed to
   * `mintLicense` unchanged — this layer decides nothing about them, because pricing a scope and
   * deciding who may buy one are the control plane's business, not the gate's.
   *
   * `period` is the PURCHASED term and is independent of `LICENSE_TTL_SECONDS`, which stays the
   * re-read window and stays capped. A licence that entitles a read still expires.
   */
  licence?: LicenceFacts;
}

export async function settleAndAttribute(args: SettleArgs): Promise<SettleResult> {
  const { payment, legs, quote: q, publisher, host, now, licence } = args;

  const result = await verifyAndSettle(payment, legs, now, publisher.id);
  if (!result.ok) return { ok: false, error: result.error, ...(result.stage ? { stage: result.stage } : {}) };

  // Paid. Resolve the chain this settled on from the author leg the 402 advertised
  // (per-tenant), falling back to the fleet default — so the license + the earnings
  // settlement both name the chain the money actually moved on, not a global.
  const settleNet = networkByCaip2(legs[0]?.requirements.network ?? "") ?? activeNetwork();
  const licenseNetwork = {
    chainId: settleNet.chainId,
    usdc: settleNet.usdc,
    gateway: settleNet.gatewayWallet,
  };

  // What this buyer was asked for and never authorized, carried through PER LEG. Summing it here
  // is what made a co-author's unpaid cut report as naulon's own uncollected fee: the settle layer
  // knows the roles and the payees, and a total throws both away. The layer that owns the ledger
  // row records what happened; deciding what each leg MEANS belongs to whoever reads it.
  const forgoneLegs = result.forgoneLegs ?? [];

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
    // The host that was tolled. A publisher can serve many; without this the ledger can only say
    // the PUBLISHER earned recently, never which of its domains did.
    host,
    slug: q.slug,
    kind: q.kind,
    amount: usdc(q.price),
    payees: q.payees,
    payerAddress: walletAddress(payerResolved),
    settlementRef: result.settlementRef ?? "unknown",
    // Stamp the settle chain so a later drain re-sends on the same chain (survives
    // a multi-network fleet). Absent on pre-per-tenant events ⇒ activeNetwork().
    chainId: settleNet.chainId,
    // Book what a stock x402 payer left uncollected. Spread so the key is ABSENT on every normal
    // settle — the overwhelmingly common case — keeping the ledger row byte-identical to what it
    // was, rather than adding an empty array to millions of rows to describe nothing happening.
    ...(forgoneLegs.length > 0 ? { forgoneLegs } : {}),
    // What a SALE bought. Spread so a toll's row is byte-identical to what it was before sales
    // existed. It has to be on the ROW, not only in the token minted three lines below: the
    // permanent citation record is minted from the STORED event by `/licenses/:jti/record`, long
    // after this function's `licence` argument is gone, so anything absent here can never appear
    // in the object a stranger verifies.
    ...(licence ? { licence } : {}),
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
        // Spread so every key stays ABSENT on a toll. `mintLicense` treats absent as "today's
        // single-slug licence with sub = the payer", so a settle that passes no `licence` emits
        // the same bytes it did before this field existed — which is what the parity test asserts.
        ...(licence?.scope ? { scope: licence.scope } : {}),
        ...(licence?.terms ? { terms: licence.terms } : {}),
        ...(licence?.period ? { period: licence.period } : {}),
        ...(licence?.subject ? { subject: licence.subject } : {}),
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

  // Wire #4, self-host webhooks — the ONLY settlement report now. The origin-mirror that used to
  // run beside it (`emitSettlement` → POST ${originUrl}/api/credits/settlement, HMAC-signed) is
  // gone: it was a second delivery mechanism for the same fact, with its own retry engine, its own
  // delivery-state store and its own secret, and a publisher had to implement a receiver endpoint
  // to get what a webhook subscription now gives them. Host is derived from the publisher origin so
  // a hostFilter can match; dark-safe + never throws.
  const webhookHost = (() => {
    try {
      return new URL(publisher.originUrl).host;
    } catch {
      return null;
    }
  })();
  void emitSettlementWebhook(event, webhookHost).catch((err: unknown) => {
    console.error("[tollgate] webhook emit threw (payment already settled):", err);
  });

  return {
    ok: true,
    eventId: event.id,
    settlementRef: result.settlementRef,
    payer: payerResolved === ZERO_ADDRESS ? result.payer : payerResolved,
    responseHeader: result.responseHeader,
    licenseJws,
    // Spread so the key is ABSENT on every normal settle, exactly as it is on the ledger row —
    // a caller checking `forgoneLegs` gets undefined, never an empty array meaning the same thing.
    ...(forgoneLegs.length > 0 ? { forgoneLegs } : {}),
  };
}
