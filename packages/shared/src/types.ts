/**
 * Core domain types shared across the four naulon components.
 *
 * The thesis in one type: an attributed read/citation event resolves to one or
 * more author wallets, each owed a fraction of the toll. Attribution metadata
 * *is* the payout rule.
 */

// The wallet + credits contract primitives now live in @naulon/sdk (the
// publisher SDK — one source of truth for the money-routing wire contract).
// Imported for use in the gate-internal types below AND re-exported so every
// existing `from "@naulon/shared"` import keeps resolving unchanged.
import { walletAddress } from "@naulon/sdk";
import type { WalletAddress, ArticleCredits, Contributor, CreditsResolver } from "@naulon/sdk";
import type { PaymentFailureReason } from "./paymentfailure.ts";
export { walletAddress };
export type { WalletAddress, ArticleCredits, Contributor, CreditsResolver };

/** USDC amount in whole-token units (e.g. 0.001 = one tenth of a cent). */
export type Usdc = number & { readonly __brand: "Usdc" };

/** Gateway nanopayment floor. Amounts below this can't settle. */
export const USDC_FLOOR = 0.000001 as Usdc;

export function usdc(value: number): Usdc {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid USDC amount: ${value}`);
  }
  return value as Usdc;
}

/** A reason a request must pay — what kind of machine consumption happened. */
export type TollKind = "read" | "citation";

/**
 * An author and the share of a toll they are owed.
 * `share` is a fraction in [0, 1]; shares across a split sum to 1.
 */
export interface AuthorShare {
  authorId: string;
  wallet: WalletAddress;
  share: number;
}

/** A 402 payment requirement the tollgate hands an agent. */
export interface PaymentRequirement {
  slug: string;
  kind: TollKind;
  price: Usdc;
  /** Where settlement lands — resolved author wallets + shares. */
  payees: AuthorShare[];
  /** Arc network coordinates the agent needs to construct payment. */
  network: { chainId: number; usdc: WalletAddress; gateway: string };
  /** Opaque nonce the agent echoes back in its signed payment. */
  nonce: string;
}

/**
 * Where attributed events are written and read. JSONL today; swap for
 * Supabase/Postgres by implementing this interface — callers (tollgate,
 * attribution, dashboard) don't change. Mirrors the CreditsResolver seam.
 */
export interface EventSink {
  record(event: AttributedEvent): Promise<void>;
  /**
   * Read events from the ledger. The optional `publisherId` filters to one
   * publisher's events — an embedding seam a downstream resolver-based deploy can
   * use to drain a single publisher in isolation. Omitted (the single-tenant
   * default, and every OSS caller — dashboard, attribution) returns every event.
   */
  readAll(publisherId?: string): Promise<AttributedEvent[]>;
  /**
   * Fetch a single event by id (= a license `jti`). Backs `GET /licenses/:jti`
   * without scanning the whole ledger — Supabase does a primary-key lookup;
   * jsonl short-circuits on the first match. Returns undefined if not found.
   */
  get(id: string): Promise<AttributedEvent | undefined>;
}

/** A settled, attributed event — the row the dashboard reads. */
/**
 * A leg the quote required and the buyer never authorized.
 *
 * Deliberately NOT a `PayoutLeg`: a PayoutLeg is an instruction to pay someone and carries a
 * validated `WalletAddress`, whereas this is a record that a payment did NOT happen. Branding it
 * would mean running an address validator on the settle path to describe money that did not move —
 * a throw where there is nothing to gain.
 *
 * It lives HERE rather than in `@naulon/tollgate` because `AttributedEvent` carries it and shared
 * is the base package; tollgate re-exports it so the settle surface reads unchanged.
 */
export interface ForgoneLeg {
  /** The ledger label the quote gave it ("operator", "coauthor", …). */
  role: string;
  /** Who would have been paid. Reported as advertised, not re-validated. */
  payTo: string;
  /** Atomic micro-USDC, integer string — the amount that went uncollected. */
  amount: string;
}

export interface AttributedEvent {
  id: string;
  /**
   * The publisher this event is attributed to — `PublisherConfig.id` (the default
   * resolver's is `"default"`). Optional: an embedding seam a downstream
   * resolver-based deploy uses to attribute earnings; the single-tenant core
   * neither filters nor drains on it, and every existing ledger row stays valid.
   */
  publisherId?: string;
  /**
   * The Host header this toll was collected on — the same identity the gate routes by, and the
   * same field `ObservationEvent` has carried since it existed.
   *
   * Optional for the same reason `publisherId` is: it is an embedding seam, and every ledger row
   * written before it existed stays valid. The single-tenant core neither filters nor drains on it.
   *
   * Why it is worth having: a publisher can serve MANY hosts, and without this the ledger can only
   * answer "has this publisher been paid recently", never "has THIS host been paid recently". A
   * resolver-based deploy that classifies per host then has to attribute a whole tenant's traffic
   * to each of its hosts — so a domain that has never been read once reads as actively earning. The
   * settle tail knows the host at the moment it writes the row; nothing downstream can recover it.
   */
  host?: string;
  slug: string;
  kind: TollKind;
  amount: Usdc;
  payees: AuthorShare[];
  payerAddress: WalletAddress;
  /** Gateway settlement / batch reference. */
  settlementRef: string;
  /**
   * Every leg the quote required that this buyer never authorized — role, payee and amount, one
   * entry each. The booking side of honouring a STOCK x402 payment: such a client signs only
   * `accepts[0]` (the x402 spec defines `accepts` as alternatives and `payTo` as a single string),
   * and `build402` reduces `accepts[0]` to the PRIMARY author's own share — so on a co-authored,
   * fee-bearing toll the legs left here are the co-authors' cuts AND the operator fee together.
   *
   * **Per leg, never a sum.** A total cannot say whose money it was, and the two kinds are owed to
   * different people: an operator leg is naulon's, a coauthor leg is that author's. Summing them
   * made a co-author's unpaid cut report as naulon revenue — the exact confusion the fee-revenue
   * plane exists to end. It also cannot say WHICH co-author, and an author being shown someone
   * else's shortfall is worse than being shown none.
   *
   * A forgone leg has no signed authorization and no nonce, so it can never be a pending leg and
   * no drain can ever settle it. This row is the only trace it will ever leave — and it is the one
   * record BOTH settle paths write (the gate's proxy handler and the hosted `/verify`), so neither
   * path can book it differently.
   *
   * Optional, like `publisherId`/`host`: a multi-leg payer — the normal case — leaves it ABSENT
   * rather than `[]`, so "absent" and "nothing was forgone" are the same statement and no
   * historical row needs rewriting to say nothing happened.
   */
  forgoneLegs?: ForgoneLeg[];
  /**
   * The chain this event settled on (the per-tenant settlement network's chainId).
   * Optional: stamped by the settle tail so a later drain re-sends on the right
   * chain even across a multi-network fleet. Absent (every pre-per-tenant event) ⇒
   * the settlement body falls back to `activeNetwork().chainId`, unchanged.
   */
  chainId?: number;
  /** epoch ms — passed in by the caller (no ambient clock in shared code). */
  at: number;
}

/**
 * What happened to a gated request, for the observability/audit plane. Unlike
 * `AttributedEvent` (which exists ONLY when money moved), an observation is
 * emitted for every gated-route decision — including the ones that earn nothing:
 * a crawler served free, an agent that got a 402 and walked away. That negative
 * space ("who is reading/scraping me without paying") is the audit product; the
 * settlement ledger structurally can't see it.
 */
export type ObservationVerdict =
  /** Read free — a human, or a crawler the publisher allow-listed (e.g. search). */
  | "served-free"
  /** An agent re-read on a valid, unexpired license (already paid earlier). */
  | "agent-reread"
  /** An agent got a 402 and presented no payment — the "scrape attempt, blocked". */
  | "denied"
  /** An agent the publisher explicitly blocked — refused 403, payment or not. */
  | "blocked"
  /** An agent presented payment that failed verify/settle — never served. */
  | "payment-failed"
  /**
   * An agent presented a payment we chose NOT to take, because the origin could not serve the
   * read. Nothing was charged and the origin's own status was passed back.
   *
   * Distinct from `payment-failed`: the PAYMENT was fine, the SALE was not. It is the publisher's
   * only signal that their catalog prices something their origin does not serve — invisible from
   * every other angle, because the quote is well-formed, the buyer is solvent, and the toll
   * "works". Before this existed the money moved first and the buyer received the origin's 404.
   */
  | "unservable"
  /** An agent paid; content served + license minted. Mirrors an `AttributedEvent`. */
  | "paid";

/**
 * The same vocabulary at RUNTIME — the one list anything that enumerates verdicts builds on.
 *
 * A union cannot be iterated, so every consumer that needed to count or render verdicts
 * hand-wrote its own copy, and three of them drifted: adding `unservable` above left the
 * dashboard's `traffic.ts`, `ops.ts` and `public/shell.js` on six entries. Both aggregators skip
 * a verdict they do not know (`if (o.verdict in byVerdict)`), so the new verdict counted toward
 * the total and toward none of the bars — the bars silently stopped summing. tsc could not see
 * it: those zero-maps are built with `Object.fromEntries(...) as Record<ObservationVerdict,
 * number>`, and a cast is a promise, not a check.
 *
 * The assertion below makes this list and the union one thing. Adding a member to either without
 * the other is a type error, not a runtime surprise.
 *
 * Order is presentation order — free → refused → money.
 */
export const OBSERVATION_VERDICTS = [
  "served-free",
  "agent-reread",
  "denied",
  "blocked",
  "payment-failed",
  "unservable",
  "paid",
] as const satisfies readonly ObservationVerdict[];

/** True only when A and B are the same type in both directions. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time exhaustiveness: `OBSERVATION_VERDICTS` covers `ObservationVerdict` and nothing
 *  more. `satisfies` above already rejects an entry that is not a verdict; this rejects a verdict
 *  the list forgot — the direction that actually broke. */
const _verdictListIsExhaustive: MutuallyAssignable<
  ObservationVerdict,
  (typeof OBSERVATION_VERDICTS)[number]
> = true;
void _verdictListIsExhaustive;

/**
 * One gated-request observation. Telemetry only — it never gates a request or
 * moves money; emitting it must never change a serving decision. Higher volume
 * and lower value than `AttributedEvent`, so a sink is expected to TTL/sample it.
 */
export interface ObservationEvent {
  /** uuid. */
  id: string;
  /** The publisher this request resolved to (`PublisherConfig.id`); optional like `AttributedEvent`. */
  publisherId?: string;
  /** The Host header the request came in on. */
  host: string;
  /** The article slug the gate priced (empty string for a non-article gated path). */
  slug: string;
  /** read | citation when the request reached the machine path; absent for a plain human read. */
  kind?: TollKind;
  verdict: ObservationVerdict;
  /** The classifier's call — what the gate thought the caller was. */
  classifiedAs: "human" | "agent";
  /** Why the classifier ruled that way (e.g. which UA pattern matched). */
  classifyReason?: string;
  /** Raw User-Agent — the MVP identity basis (spoofable; Web Bot Auth supersedes it). */
  agentUa?: string;
  /** True when the caller's Web Bot Auth signature (RFC 9421/Ed25519) verified. */
  verified?: boolean;
  /** The verified operator's directory host (e.g. "chatgpt.com"), when verified. */
  verifiedAgent?: string;
  /**
   * True when a signature was PRESENTED and failed verification — a masquerade
   * attempt (or a badly broken signer), distinct from plain unsigned traffic.
   */
  sigInvalid?: boolean;
  /** The quoted price (paid → settled; denied/payment-failed → what they'd have paid = "earnings missed"). */
  price?: Usdc;
  /**
   * WHY a `payment-failed` failed — set only on that verdict, absent on every other. A closed set
   * ({@link PaymentFailureReason}), never the raw settle error, because this is shown to the
   * publisher and the raw string carries a counterparty address and leg amounts.
   *
   * Without it the audit plane counts failures it cannot explain: prod 2026-08-03 showed four
   * `payment-failed` rows that were indistinguishable from four broke buyers, when the real cause
   * was the publisher's own `settlement_network` pointing at a chain no buyer was funded on.
   */
  failureReason?: PaymentFailureReason;
  /** epoch ms — passed in by the caller (no ambient clock in shared code). */
  at: number;
}

/**
 * Where gated-request observations are written. A deliberate sibling of
 * `EventSink` — same backend story (jsonl / supabase), same one-way seam — but
 * write-only from the gate's side; the downstream audit BFF owns reads. Defaults
 * to a no-op so the open core records nothing unless a deploy opts in.
 */
export interface ObservationSink {
  record(observation: ObservationEvent): Promise<void>;
}
