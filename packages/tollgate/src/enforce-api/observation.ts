/**
 * One decision an in-app runtime made, in the shape this API can vouch for, and its projection onto
 * the gate's `ObservationEvent` so a row from an in-app runtime and a row from the proxy are
 * indistinguishable downstream.
 *
 * `publisherId` is always the authenticated publisher, resolved from the key, never from the body.
 */
import { randomUUID } from "node:crypto";
import {
  usdc,
  type FreeReason,
  type IdentityCheck,
  type ObservationEvent,
  type ObservationVerdict,
  type PaymentFailureReason,
  type TollKind,
} from "@naulon/shared";

/** Who the caller was, as the publisher's own classifier saw them. Display data, never authorization. */
export interface ReportedAgent {
  ua?: string;
  classifyReason?: string;
  verified?: boolean;
  verifiedAgent?: string;
  sigInvalid?: boolean;
}

export interface InAppObservation {
  publisherId: string;
  host: string;
  slug: string;
  /** The request pathname, no query. */
  path?: string;
  /** On a person's read, the host of the other site that sent them. */
  referrerHost?: string;
  kind?: TollKind;
  verdict: ObservationVerdict;
  classifiedAs: "human" | "agent";
  /** Quoted price in whole USDC (paid: settled; denied or failed: what would have been paid). */
  priceUsdc?: number;
  /** Why a `payment-failed` failed. Written from this API's own settle, never accepted from a client. */
  failureReason?: PaymentFailureReason;
  at: number;
  agent?: ReportedAgent;
  identityCheck?: IdentityCheck;
  claimedOperator?: string;
  forgedFrom?: string;
  observeOnly?: true;
  crawlerBudget?: "within" | "over";
  paymentPresented?: true;
  freeReason?: FreeReason;
  /** On a `paid` row from this API's settle: the ledger row id, which is the licence jti. */
  licenseJti?: string;
}

export type ObservationEmitter = (observation: InAppObservation) => void;

// Caps on reported strings. Truncated rather than rejected, so a slightly oversized field never
// costs an otherwise true observation.
const MAX_SLUG = 512;
const MAX_PATH = 2048;
const MAX_UA = 512;
const MAX_REASON = 128;
const MAX_VERIFIED_AGENT = 253;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cap(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * The `ObservationEvent` the gate's sinks store. `id` is minted here: a client-supplied id would let
 * a retry overwrite an unrelated row in a sink that upserts on it. A negative or non-finite price is
 * dropped rather than thrown on.
 */
export function toObservationEvent(o: InAppObservation, id: string = randomUUID()): ObservationEvent {
  const price = o.priceUsdc !== undefined && Number.isFinite(o.priceUsdc) && o.priceUsdc >= 0 ? usdc(o.priceUsdc) : undefined;
  const event: ObservationEvent = {
    id,
    publisherId: o.publisherId,
    host: o.host,
    slug: cap(o.slug, MAX_SLUG) ?? "",
    verdict: o.verdict,
    classifiedAs: o.classifiedAs,
    at: o.at,
  };
  if (o.kind !== undefined) event.kind = o.kind;
  const path = cap(o.path, MAX_PATH);
  if (path !== undefined) event.path = path;
  const ref = cap(o.referrerHost, 253);
  if (ref !== undefined && o.classifiedAs === "human") event.referrerHost = ref;
  if (price !== undefined) event.price = price;
  if (o.verdict === "payment-failed" && o.failureReason !== undefined) event.failureReason = o.failureReason;
  const ua = cap(o.agent?.ua, MAX_UA);
  if (ua !== undefined) event.agentUa = ua;
  const reason = cap(o.agent?.classifyReason, MAX_REASON);
  if (reason !== undefined) event.classifyReason = reason;
  if (o.agent?.verified !== undefined) event.verified = o.agent.verified;
  const verifiedAgent = cap(o.agent?.verifiedAgent, MAX_VERIFIED_AGENT);
  if (verifiedAgent !== undefined) event.verifiedAgent = verifiedAgent;
  if (o.agent?.sigInvalid !== undefined) event.sigInvalid = o.agent.sigInvalid;
  if (o.identityCheck !== undefined) event.identityCheck = o.identityCheck;
  if (o.claimedOperator !== undefined) event.claimedOperator = o.claimedOperator;
  if (o.forgedFrom !== undefined) event.forgedFrom = o.forgedFrom;
  if (o.observeOnly) event.observeOnly = true;
  if (o.crawlerBudget !== undefined) event.crawlerBudget = o.crawlerBudget;
  if (o.paymentPresented) event.paymentPresented = true;
  if (o.freeReason !== undefined) event.freeReason = o.freeReason;
  if (o.verdict === "paid" && o.licenseJti !== undefined && UUID.test(o.licenseJti)) event.licenseJti = o.licenseJti;
  return event;
}
