/**
 * Price a read/citation and resolve who gets paid.
 *
 * Pricing is publisher-agnostic: it asks the resolved publisher's `CreditsResolver`
 * for the article's credits graph, then flattens it to payees via the shared
 * attribution logic. Everything publisher-specific (the credits source, the base
 * price) arrives on the `PublisherConfig` — this function reads no global config, so
 * one gate prices many publishers correctly.
 */
import {
  resolvePayees,
  usdc,
  type AuthorShare,
  type PayoutLeg,
  type PublisherConfig,
  type TollKind,
  type Usdc,
} from "@naulon/shared";

export interface Quote {
  slug: string;
  title: string;
  kind: TollKind;
  price: Usdc;
  payees: AuthorShare[];
  /**
   * Additional settlement legs beyond the author payment, resolved from the
   * publisher's `extraLegs` hook. Empty for the single-tenant default and every
   * publisher that declares no extra legs — in which case the 402 and settle path
   * are byte-identical to a plain single-author toll. Additive: these never alter
   * `price`/`payees`; the buyer's total is `price + Σ legs`.
   */
  extraLegs: PayoutLeg[];
  /**
   * Pay co-authors directly on-chain (split-at-source) — carried from the resolved
   * `PublisherConfig.coauthorSplit`. When true AND `payees.length > 1`, `build402`
   * divides the author `price` into the primary's synchronous leg + one deferred leg
   * per other co-author (custody-free). Off / single-author → the stock single
   * author-leg toll. Never changes `price` or `payees` (the recorded truth); only the
   * on-chain leg recipients/amounts.
   */
  coauthorSplit: boolean;
  /**
   * Optional reconciliation id for the on-chain memo (Arc only). When set AND the
   * active network ships the Memo predeploy, the synchronous author leg settles via
   * the self-relay path and emits a `Memo` event keyed by this id (keccak256'd to
   * `bytes32` if not already 32-byte hex) — tying the settlement to a citation /
   * license id for offchain reconciliation. Absent, or on a memo-less network (Base),
   * the settle path is byte-identical to the stock Circle Gateway toll. Supplied by
   * the control plane; the open-core gate never invents
   * one, so the default single-tenant gate is unaffected.
   */
  memoId?: string;
}

/**
 * Price a toll event for one publisher. Citations cost more than a single read (a
 * citation has downstream reach), but both resolve to the same author payees.
 * Returns undefined for an article the publisher's credits source doesn't know —
 * the gate treats that as "don't gate".
 */
export async function quote(
  publisher: PublisherConfig,
  slug: string,
  kind: TollKind,
): Promise<Quote | undefined> {
  const credits = await publisher.credits.resolve(slug);
  if (!credits) return undefined;

  const price = usdc(kind === "citation" ? publisher.price * publisher.citationMultiplier : publisher.price);

  return {
    slug: credits.slug,
    title: credits.title,
    kind,
    price,
    payees: resolvePayees(credits),
    // Additive secondary legs (none for the single-tenant default). The hook owns
    // all amount math; pricing just carries what it returns through to the quote.
    extraLegs: publisher.extraLegs?.(price, kind) ?? [],
    // Carried through to build402, which owns the split-at-source math (it has the
    // primary-payee tiebreak config). Off unless the resolver opts the publisher in.
    coauthorSplit: publisher.coauthorSplit ?? false,
    // The control plane owns the memo id's format; the core just carries what the
    // hook returns. Spread so an unset hook (or one returning undefined) leaves the
    // key absent entirely — the settle path then keys the memo off the auth nonce,
    // byte-identical to the stock single-tenant toll.
    ...(() => {
      const memoId = publisher.memoId?.({ slug: credits.slug, kind });
      return memoId ? { memoId } : {};
    })(),
  };
}
