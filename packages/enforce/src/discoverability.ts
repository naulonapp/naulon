/**
 * Toll discoverability — let an agent learn the gate exists, and its terms,
 * without being told out of band.
 *
 *   - `/.well-known/x402` serves a machine-readable manifest for the one
 *     publisher this gate fronts: the article path prefixes, the price for a read
 *     and a citation, the Arc/USDC network, and where to verify a license.
 *   - A `Link: rel="payment"` header on every 402 points an agent at that manifest.
 *
 * The manifest is article-agnostic, so it never names author wallets — payTo is
 * resolved per article from the credits graph at payment time (custody-free,
 * buyer → author). It's a discovery hint, not concrete x402 PaymentRequirements:
 * to pay, an agent GETs an article URL and reads the 402's PAYMENT-REQUIRED header.
 *
 * Everything here derives from the resolved `PublisherConfig` + the Arc network
 * constants — no new per-publisher seam.
 */
import { activeNetwork, getConfig, issuerHost, toAtomicUsdc, usdc, type PublisherConfig, type SettlementNetwork, type TollKind } from "@naulon/shared";
// The manifest MUST advertise the same validity window the real 402 does, so import it rather than
// re-declaring it (see the note at the old constant's site below).
import { MAX_TIMEOUT_SECONDS } from "./build402.ts";
import { toMicro } from "./crawlerPrice.ts";
import { tollPriceUnder } from "./pricing.ts";

/** Well-known path for the toll manifest. */
export const X402_MANIFEST_PATH = "/.well-known/x402";
/** JWKS path (kept in sync with the route registered in app.ts). */
const JWKS_PATH = "/.well-known/naulon-jwks.json";
/** Online license verification path template. */
const LICENSE_VERIFY_PATH = "/licenses/{jti}";
/** The permanent citation record, minted from the same ledger row. */
const LICENSE_RECORD_PATH = "/licenses/{jti}/record";

/**
 * The proof-page template, `host` filled in from the publisher's identity and `{jti}` left for
 * the buyer. Built by hand rather than through `proofPageUrl` because that helper would encode
 * the braces; the query joiner still respects a page URL that already carries a query.
 */
function proofTemplate(licenseIdentity: string): string {
  const base = getConfig().VERIFY_PAGE_URL;
  const host = issuerHost(licenseIdentity) ?? "";
  return `${base}${base.includes("?") ? "&" : "?"}host=${encodeURIComponent(host)}&jti={jti}`;
}

/** `Link` header value pointing an agent at the manifest (RFC 8288). */
export const PAYMENT_LINK_HEADER = `<${X402_MANIFEST_PATH}>; rel="payment"; type="application/json"`;

/**
 * The all-in figure for one toll, summed across every leg the 402 will carry.
 *
 * `atomic` is authoritative. `usdc` is for display and is derived from it, so the FEE is
 * `buyerTotal.atomic - atomic`, never `buyerTotal.usdc - usdc`: a base price carrying sub-micro
 * precision rounds into `atomic` and does not into `usdc`, so subtracting the display figures
 * returns the fee plus that rounding. Integer units are exact here up to 2^53 micro-USDC, which is
 * about nine billion dollars on one read.
 */
export interface BuyerTotal {
  /** Atomic USDC (6 decimals), summed across every leg. */
  atomic: string;
  /** Human USDC, for display. Derived from `atomic`; do not do money math on it. */
  usdc: number;
}

export interface PriceLeg {
  /** Atomic USDC (6 decimals) — what the on-chain leg moves. */
  atomic: string;
  /** Human USDC, for display. */
  usdc: number;
  /**
   * What the buyer must authorize IN TOTAL to complete this toll, when that is MORE than the leg
   * above. Absent when the two are equal, which is every self-hosted gate and every publisher whose
   * resolver declares no `extraLegs` — so a manifest without a secondary leg is byte-identical to
   * before this field existed.
   *
   * It is a separate field rather than a bigger `atomic` because `atomic` names ONE transfer and
   * has to keep naming it: x402's `accepts` is a list of ALTERNATIVES, not simultaneous transfers,
   * so a gate with a secondary leg declares that leg in its own extension and the buyer signs one
   * authorization per entry. Widening `atomic` would also import another fleet's operator fee as a
   * publisher's own price wherever a manifest is read to onboard a self-hoster.
   *
   * What went wrong without it is a BUDGET, not a refusal. A stock client that signs `accepts[0]`
   * is served and the remaining legs are recorded as forgone, so nothing here can cost a buyer
   * their read; the `/verify` fee check is a publisher-integrity check and no buyer payment can
   * trigger it. The cost is that an agent sizing a ceiling from this document under-provisions by
   * the fee on every read, while the client debits the true total, and that the fee it was never
   * offered goes uncollected.
   *
   * The spec defines no field for a cross-transfer total, so this name is naulon's own. It is NOT
   * under an `extensions` key like the 402's `naulonLegs`, because this document has no extension
   * envelope to put it in; a future spec field of the same name would collide, and moving it then
   * is the cheaper direction than inventing an envelope now.
   */
  buyerTotal?: BuyerTotal;
}

export interface X402Manifest {
  x402Version: number;
  /** The product's contract, machine-readable: humans read free, machines pay. */
  humansReadFree: true;
  /**
   * What an agent read costs under the publisher's stated `ai-input` term. `"free"` means the gate
   * serves agents without a 402 and every price below is zero; `"refused"` means the gate answers
   * 403 whatever is paid. Present only when the publisher stated the term, so a manifest without
   * terms is byte-identical to before this field existed.
   */
  agentReads?: "priced" | "free" | "refused";
  resources: {
    /**
     * What the toll covers — the manifest's spelling of `PublisherConfig.gateScope`.
     * `"prefixes"` (the default) tolls only paths under `pathPrefixes`; `"site"` tolls
     * every path except `excludePrefixes` and the always-free discovery surfaces.
     */
    scope: "prefixes" | "site";
    /**
     * Path prefixes (no leading slash) whose articles are tolled. Present in `"prefixes"`
     * scope only — a site-scoped publisher has no prefix list, and printing its (usually
     * vestigial) `articlePrefixes` here told an agent that a handful of paths were tolled
     * when in fact the whole site was. Absent is honest; a wrong list is not.
     */
    pathPrefixes?: string[];
    /** Publisher-chosen free sections. Present in `"site"` scope only. */
    excludePrefixes?: string[];
    /** Toll kinds; a citation is priced up from a read. */
    kinds: ["read", "citation"];
    /** Header an agent sets to request the citation toll instead of a read. */
    selectKindHeader: string;
    note: string;
  };
  payment: {
    scheme: "exact";
    network: string;
    chainId: number;
    asset: string;
    currency: "USDC";
    maxTimeoutSeconds: number;
    price: {
      read: PriceLeg;
      citation: PriceLeg & { multiplier: number };
      /**
       * Per-path overrides, in the publisher's own resolution order (most specific first) — the
       * same list and the same order the toll resolves against. `read`/`citation` above are the
       * BASE, which applies to every path no rule claims.
       *
       * Present only when the publisher sets rules, so a manifest without them is byte-identical
       * to before this field existed. Absent it, this document declared the site base for a
       * section the gate charged differently — measured on a live gate 2026-09-07: the manifest
       * said `0.03` while the 402 for a path under a priced rule carried
       * `crawler-price: USD 0.10`. An agent that budgets from discovery under-authorizes, and the
       * payment it had already agreed to fails. Same class as the `maxTimeoutSeconds` drift noted
       * below, one field over.
       */
      rules?: {
        /** RFC 9309 path pattern, exactly as the publisher stored it. */
        pattern: string;
        read: PriceLeg;
        citation: PriceLeg & { multiplier: number };
      }[];
    };
    /** How the single on-chain recipient is chosen (wallets are never listed here). */
    payTo: string;
  };
  license: {
    jwks: string;
    verify: string;
    /** The permanent citation record for a settlement — `{jti}` is the licence's `jti`. */
    record: string;
    /**
     * The page a reader opens to see the record checked against this gate's published keys, in
     * their own browser. `host` is pre-filled with this publisher; `{jti}` is the licence's.
     * This is the link a citation should carry beside the source.
     */
    proof: string;
    /** issuer === audience for this publisher's Citation License Tokens. */
    identity: string;
  };
  /** Public catalog enumeration endpoint, advertised when the publisher sets one. */
  catalog?: { url: string };
}

// (MAX_TIMEOUT_SECONDS is imported from build402.ts above.)
//
// This was a SECOND hardcoded `345_600` (4 days) — the exact value `X402_MAX_TIMEOUT_SECONDS` was
// changed to eliminate. Its zod schema now hard-floors at >= 604_900 specifically so "a future edit
// can't silently re-arm the 4d footgun this fix removed" — but this copy was never updated, so
// `/.well-known/x402`, the documented discovery entry point, kept advertising 4 days while the gate
// actually issued up to 8. Any non-SDK buyer planning its validity budget from the manifest got the
// footgun back at the discovery layer. One source of truth now; the drift cannot recur.

/** Build the discovery manifest for the publisher this gate fronts. */
export function buildX402Manifest(
  publisher: PublisherConfig,
  net: SettlementNetwork = activeNetwork(),
): X402Manifest {
  // Through `tollPriceUnder` — the ONE price formula — never `publisher.price` and a local
  // multiply. A rule overrides the read price and the multiplier independently, and re-deriving
  // that here is precisely the second copy of a money formula this package refuses elsewhere.
  // A read the terms give away is priced at zero here too, so the document an agent budgets from
  // and the gate it then meets cannot disagree.
  const aiInput = publisher.termsPolicy?.["ai-input"];
  const agentReads = aiInput === "free" ? "free" : aiInput === "prohibit" ? "refused" : aiInput === "priced" ? "priced" : undefined;
  const free = agentReads === "free";
  const readUsdc = free ? 0 : (tollPriceUnder(publisher, "read", undefined) as number);
  const citationUsdc = free ? 0 : (tollPriceUnder(publisher, "citation", undefined) as number);
  /**
   * One leg, plus the total when a secondary leg makes them differ.
   *
   * Applied PER AMOUNT and with the amount's own KIND, never scaled from the base: a resolver's
   * fee math may carry a floor and a cap (the naulon control plane's does), so it is not
   * proportional and a citation total is not a read total times the multiplier. `extraLegs` is
   * the publisher's own hook and the same one `build402.ts` assembles the wire from, so this
   * document and the 402 cannot state different numbers.
   */
  const leg = (usd: number, kind: TollKind): PriceLeg => {
    const base: PriceLeg = { atomic: toAtomicUsdc(usd), usdc: usd };
    if (free) return base;
    // A fee hook is code the GATE does not own, and until this field existed it ran only on the
    // paid path, where a throw is a refused payment. This document is public and unauthenticated,
    // and the SDK that consumes it resolves a failed fetch to null and then serves the read FREE.
    // So a broken hook costs the TOTAL, never the document: omit `buyerTotal` and let the paid
    // path fail loudly, where a failure is visible and costs nobody their content.
    let micro: bigint;
    try {
      const extra = publisher.extraLegs?.(usdc(usd), kind) ?? [];
      if (extra.length === 0) return base;
      // `toMicro`, not a bare `BigInt`: it refuses anything that is not integer digits by name,
      // so a hex or decimal amount is a named error rather than a silent 16x or a SyntaxError.
      micro = extra.reduce((sum, l) => sum + toMicro(l.amount), toMicro(base.atomic));
    } catch {
      return base;
    }
    // `<=`, not `===`. A leg is additive by contract, so a total at or under the leg means a hook
    // that returned something it should not have, and a `buyerTotal` BELOW `atomic` would
    // under-fund a buyer who trusted it — the same failure this field exists to prevent, mirrored.
    if (micro <= toMicro(base.atomic)) return base;
    return { ...base, buyerTotal: { atomic: micro.toString(), usdc: Number(micro) / 1_000_000 } };
  };
  const ruleLegs = (free ? [] : (publisher.priceRules ?? [])).map((rule) => {
    const read = tollPriceUnder(publisher, "read", rule) as number;
    const citation = tollPriceUnder(publisher, "citation", rule) as number;
    return {
      pattern: rule.pattern,
      read: leg(read, "read"),
      // The multiplier is the rule's own when it names one, else the site's — stated per rule so an
      // agent never has to recompute which of the two fields the rule actually moved.
      citation: { ...leg(citation, "citation"), multiplier: rule.citationMultiplier ?? publisher.citationMultiplier },
    };
  });
  return {
    x402Version: 2,
    humansReadFree: true,
    ...(agentReads ? { agentReads } : {}),
    resources:
      publisher.gateScope?.mode === "site"
        ? {
            scope: "site",
            excludePrefixes: publisher.gateScope.excludePrefixes,
            kinds: ["read", "citation"],
            selectKindHeader: "X-Naulon-Kind",
            note:
              "Every path on this site is tolled except the listed exclusions and the always-free"
              + " discovery surfaces (robots, sitemaps, feeds, favicon). GET any URL to receive a 402"
              + " with concrete PaymentRequirements.",
          }
        : {
            scope: "prefixes",
            pathPrefixes: publisher.articlePrefixes,
            kinds: ["read", "citation"],
            selectKindHeader: "X-Naulon-Kind",
            note: "GET any article URL under a prefix to receive a 402 with concrete PaymentRequirements.",
          },
    payment: {
      scheme: "exact",
      network: net.network,
      chainId: net.chainId,
      asset: net.usdc,
      currency: "USDC",
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      price: {
        read: leg(readUsdc, "read"),
        citation: { ...leg(citationUsdc, "citation"), multiplier: publisher.citationMultiplier },
        ...(ruleLegs.length > 0 ? { rules: ruleLegs } : {}),
      },
      payTo:
        "Resolved per article to the primary author from the publisher's credits graph; the recursive co-author split is recorded on each settled event. Custody-free: settlement is buyer → author.",
    },
    license: {
      jwks: JWKS_PATH,
      verify: LICENSE_VERIFY_PATH,
      record: LICENSE_RECORD_PATH,
      proof: proofTemplate(publisher.licenseIdentity),
      identity: publisher.licenseIdentity,
    },
    ...(publisher.catalogUrl ? { catalog: { url: publisher.catalogUrl } } : {}),
  };
}
