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
  activeNetwork,
  resolvePayees,
  resolvePriceRule,
  usdc,
  type AuthorShare,
  type NetworkName,
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
  /**
   * The settlement chain this price is payable on — the tenant's
   * `PublisherConfig.settlementNetwork`, or the pricing runtime's active network when the
   * tenant sets none. Read by `build402`/`buildRequirements` to advertise it in the 402 and
   * resolved per-request on the settle path.
   *
   * Always present on a quote this function builds, so a runtime that did not do the pricing
   * never has to fall back to its own env to learn which chain it is quoting. Optional on the
   * TYPE only, because a quote may arrive from an older control plane that omitted it — in
   * which case `buildRequirements` still falls back to `activeNetwork()`, as it always did.
   */
  network?: NetworkName;
}

/**
 * What one toll of `kind` costs on this publisher, before any additive extra leg.
 *
 * Exported because it is the ONLY implementation of the price formula, and a second
 * caller now needs it: the multi-tenant control plane verifies a self-hosting
 * publisher's own quote against the tenant record before settling it. Deriving that
 * answer any other way means copying a money formula into a second file, which is the
 * thing the fee math already refuses to do.
 *
 * Pure and synchronous — it reads only the fields the resolver already put on the
 * config, never the credits source. `quote()` calls it for exactly the same reason a
 * verifier does, so the two can never disagree.
 *
 * `path` is the request PATHNAME (`/papers/x`), never a full URL, and it selects the publisher's
 * per-path price rule. It is optional ONLY so an older control plane that predates price rules
 * still typechecks; every caller in this repo passes it. Omitting it on a publisher that HAS
 * rules silently prices at the site base — which on the verifying side reads as "the quote does
 * not match the tenant record" and refuses a settle the publisher priced correctly. So the
 * quoting and verifying calls move together, as they already had to for the formula itself.
 */
export function tollPrice(
  publisher: Pick<PublisherConfig, "price" | "citationMultiplier" | "priceRules">,
  kind: TollKind,
  path?: string,
): Usdc {
  // A rule overrides either money field INDEPENDENTLY: one that names only a citation multiplier
  // keeps the site's read price, and vice versa. No path, no rules, or no rule matching ⇒ the two
  // site values, byte-identical to before this field existed.
  const rule = resolvePriceRule(publisher.priceRules, path);
  const price = rule?.priceUsdc ?? publisher.price;
  const multiplier = rule?.citationMultiplier ?? publisher.citationMultiplier;
  return usdc(kind === "citation" ? price * multiplier : price);
}

/**
 * Price a toll event for one publisher. Citations cost more than a single read (a
 * citation has downstream reach), but both resolve to the same author payees.
 * Returns undefined for an article the publisher's credits source doesn't know —
 * the gate treats that as "don't gate".
 *
 * `path` is the request pathname, carried only so `tollPrice` can select a per-path rule. It is
 * NOT the slug and cannot be derived from it: in prefix mode a slug is one segment of the path,
 * and in site mode the two coincide only by accident of configuration. Absent ⇒ site pricing.
 */
export async function quote(
  publisher: PublisherConfig,
  slug: string,
  kind: TollKind,
  path?: string,
): Promise<Quote | undefined> {
  const credits = await publisher.credits.resolve(slug);
  if (!credits) return undefined;

  const price = tollPrice(publisher, kind, path);

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
    // Per-tenant settlement chain — ALWAYS stamped, never conditional. A quote crosses a process boundary — the control
    // plane prices, a publisher's own runtime builds the 402 from it — and an absent
    // `network` there is not "the fleet default", it is "whatever THAT runtime's env says".
    // Measured 2026-09-02: a tenant with no per-tenant chain quoted `eip155:5042002`
    // (arcTestnet, the SDK's zod default) on a fleet running Base mainnet, so a live 402
    // advertised testnet USDC to paying agents. The price and the chain it is payable on
    // are one fact; they travel together or neither is trustworthy.
    network: publisher.settlementNetwork ?? activeNetwork().chainName,
  };
}
