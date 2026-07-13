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
export interface AttributedEvent {
  id: string;
  /**
   * The publisher this event is attributed to — `PublisherConfig.id` (the default
   * resolver's is `"default"`). Optional: an embedding seam a downstream
   * resolver-based deploy uses to attribute earnings; the single-tenant core
   * neither filters nor drains on it, and every existing ledger row stays valid.
   */
  publisherId?: string;
  slug: string;
  kind: TollKind;
  amount: Usdc;
  payees: AuthorShare[];
  payerAddress: WalletAddress;
  /** Gateway settlement / batch reference. */
  settlementRef: string;
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
  /** An agent paid; content served + license minted. Mirrors an `AttributedEvent`. */
  | "paid";

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
