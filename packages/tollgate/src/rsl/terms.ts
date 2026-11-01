/**
 * Project a resolved publisher onto the licence document's inputs. The one place the two
 * vocabularies meet; everything downstream of it is pure.
 */
import { usdc, type PublisherConfig, type TollKind } from "@naulon/shared";
import type { RslTenantTerms } from "./document.ts";

/**
 * What a buyer pays for a toll listed at `priceUsdc`: the price plus every additive leg the 402
 * carries. Summed in integer micro-USDC so the licence states exactly the amount the quote asks for.
 */
export function buyerTotalFrom(
  extraLegs: NonNullable<PublisherConfig["extraLegs"]>,
): (priceUsdc: number, kind: TollKind) => number {
  return (priceUsdc, kind) => {
    let micro = BigInt(Math.round(priceUsdc * 1_000_000));
    for (const leg of extraLegs(usdc(priceUsdc), kind)) micro += BigInt(leg.amount);
    return Number(micro) / 1_000_000;
  };
}

export function termsFor(
  host: string,
  p: {
    articlePrefixes: string[];
    price: number;
    citationMultiplier: number;
    gateScope?: PublisherConfig["gateScope"];
    priceRules?: PublisherConfig["priceRules"];
    extraLegs?: PublisherConfig["extraLegs"];
    termsPolicy?: PublisherConfig["termsPolicy"];
    licenceServer?: PublisherConfig["licenceServer"];
  },
  /** CAIP-2 chain for this host's toll, the `<accepts>` metadata. */
  x402Network?: string,
): RslTenantTerms {
  return {
    host,
    articlePrefixes: p.articlePrefixes,
    priceUsdc: p.price,
    citationMultiplier: p.citationMultiplier,
    gateScope: p.gateScope,
    ...(p.priceRules ? { priceRules: p.priceRules } : {}),
    ...(p.termsPolicy ? { termsPolicy: p.termsPolicy } : {}),
    ...(p.licenceServer ? { licenceServer: p.licenceServer } : {}),
    x402Network,
    ...(p.extraLegs ? { buyerTotalUsdc: buyerTotalFrom(p.extraLegs) } : {}),
  };
}
