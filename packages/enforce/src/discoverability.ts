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
import { activeNetwork, toAtomicUsdc, type PublisherConfig, type SettlementNetwork } from "@naulon/shared";
// The manifest MUST advertise the same validity window the real 402 does, so import it rather than
// re-declaring it (see the note at the old constant's site below).
import { MAX_TIMEOUT_SECONDS } from "./build402.ts";

/** Well-known path for the toll manifest. */
export const X402_MANIFEST_PATH = "/.well-known/x402";
/** JWKS path (kept in sync with the route registered in app.ts). */
const JWKS_PATH = "/.well-known/naulon-jwks.json";
/** Online license verification path template. */
const LICENSE_VERIFY_PATH = "/licenses/{jti}";

/** `Link` header value pointing an agent at the manifest (RFC 8288). */
export const PAYMENT_LINK_HEADER = `<${X402_MANIFEST_PATH}>; rel="payment"; type="application/json"`;

interface PriceLeg {
  /** Atomic USDC (6 decimals) — what the on-chain leg moves. */
  atomic: string;
  /** Human USDC, for display. */
  usdc: number;
}

export interface X402Manifest {
  x402Version: number;
  /** The product's contract, machine-readable: humans read free, machines pay. */
  humansReadFree: true;
  resources: {
    /** Path prefixes (no leading slash) whose articles are tolled. */
    pathPrefixes: string[];
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
    price: { read: PriceLeg; citation: PriceLeg & { multiplier: number } };
    /** How the single on-chain recipient is chosen (wallets are never listed here). */
    payTo: string;
  };
  license: {
    jwks: string;
    verify: string;
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
  const readUsdc = publisher.price as number;
  const citationUsdc = readUsdc * publisher.citationMultiplier;
  return {
    x402Version: 2,
    humansReadFree: true,
    resources: {
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
        read: { atomic: toAtomicUsdc(readUsdc), usdc: readUsdc },
        citation: {
          atomic: toAtomicUsdc(citationUsdc),
          usdc: citationUsdc,
          multiplier: publisher.citationMultiplier,
        },
      },
      payTo:
        "Resolved per article to the primary author from the publisher's credits graph; the recursive co-author split is recorded on each settled event. Custody-free: settlement is buyer → author.",
    },
    license: { jwks: JWKS_PATH, verify: LICENSE_VERIFY_PATH, identity: publisher.licenseIdentity },
    ...(publisher.catalogUrl ? { catalog: { url: publisher.catalogUrl } } : {}),
  };
}
