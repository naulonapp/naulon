/**
 * The vocabulary a licence is written in: what it entitles, what it covers, which RSL terms it
 * executes, and for how long.
 *
 * These four types sit in their own module because BOTH halves of a settled sale need them and
 * neither may import the other: `types.ts` puts them on the ledger event, `license.ts` puts them
 * in the signed claim. Defining them beside the claim and importing them into the event would
 * make the two modules cyclic; defining them twice would let the ledger and the signature
 * describe the same purchase differently, which is the one disagreement a permanent, publicly
 * verifiable record cannot survive.
 *
 * `license.ts` re-exports all of them, so `@naulon/shared` consumers see no move.
 */

/**
 * What a licence entitles.
 *
 * `"read"` is the access licence (a CLT): short-lived, because an unrevocable bearer credential's
 * expiry is the only kill switch it has. `"none"` is the CITATION RECORD: it proves a payment
 * happened, grants nothing, and is therefore safe to be permanent.
 */
export type LicenseGrant = "read" | "none";

/** RSL 1.0's usage vocabulary — the terms a licence executes. `ai-train` is never sold. */
export type LicenseTerm = "ai-input" | "ai-index" | "search";

/**
 * The scope a licence covers: RFC 9309 path patterns, the same grammar RSL borrows for
 * `content@url` and the same one the RSL emitter already writes. One dialect across the
 * gate, RSL and licences — a second grammar here is how `/articles/*` silently stops
 * matching `/articles/2026/x`.
 */
export interface LicenseScope {
  patterns: string[];
}

/**
 * The purchased period, epoch seconds. `until: null` is permanent — legal only on a
 * grant that entitles nothing.
 */
export interface LicensePeriod {
  from: number;
  until: number | null;
}

/**
 * What a SALE adds to a settled event, over what a toll records.
 *
 * A toll is one payment for one slug made after a read; it carries none of these and its ledger
 * row and minted token are byte-identical to what they were before this type existed. A sale is
 * one payment for a scope and a period made before any read, and these four fields are the whole
 * difference.
 *
 * They live on the EVENT, not only in the minted token, because the access licence and the
 * citation record are two projections of one ledger row. A field the row does not carry cannot
 * appear in the second projection: before this, a scope licence's permanent record — the object
 * a stranger checks, and the entire product — could name the payment but not what was bought.
 */
export interface LicenceFacts {
  scope?: LicenseScope;
  terms?: LicenseTerm[];
  period?: LicensePeriod;
  /**
   * A stable buyer identity (an account handle or a key) rather than the payer wallet.
   *
   * It must never carry anything that turns the public verifier into a surveillance surface:
   * an account handle or key, never an email or a name.
   */
  subject?: string;
}
