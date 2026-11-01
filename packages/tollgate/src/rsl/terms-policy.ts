/**
 * What a publisher permits, in RSL 1.0's own usage vocabulary.
 *
 * The TYPE lives in `@naulon/shared` beside `CrawlerPolicy`, because it is carried on
 * `PublisherConfig` and the gate emits the document from it. What lives here is the wire schema
 * a publisher's policy is validated against, and the mapping from a policy to the licence blocks
 * that state it.
 *
 * Every axis is OPTIONAL and an absent one means NOT STATED, which emits exactly what the
 * document emitted before this type existed. A default here would be naulon stating a policy on
 * a publisher's behalf, which is the error `document.ts` already refuses to make for `ai-train`.
 */
import { z } from "zod";
import type { TermsPolicy } from "@naulon/shared";
import type { LicenseBlock } from "./document.ts";

export type { TermsPolicy };

/** Every state any axis can be in. No single axis accepts all four. */
export type TermState = "prohibit" | "free" | "priced" | "by-agreement";

/**
 * The wire shape of a policy.
 *
 * `.strict()` is load-bearing: an unknown axis is REFUSED rather than dropped, because
 * dropping it would store a policy the publisher did not write and then publish a licence they did
 * not mean. The `by-agreement` rule is checked here: a grant with nobody to negotiate with is not a
 * grant. A store that persists policies should enforce the same rule in its own schema.
 */
export const termsPolicySchema = z
  .object({
    search: z.enum(["free", "prohibit"]).optional(),
    "ai-input": z.enum(["prohibit", "free", "priced"]).optional(),
    "ai-index": z.enum(["prohibit", "free", "priced"]).optional(),
    "ai-train": z.enum(["prohibit", "free", "by-agreement"]).optional(),
    contact: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v["ai-train"] !== "by-agreement" || typeof v.contact === "string", {
    message: "ai-train by-agreement requires a contact",
    path: ["contact"],
  }) satisfies z.ZodType<TermsPolicy>;

/** The priced facts a policy is turned into licences against. Every amount is already a BUYER
 *  TOTAL: the caller runs it through `RslTenantTerms.buyerTotalUsdc` before it arrives, because
 *  the fee has a floor and a cap and so is not proportional to the base. */
export interface PricedTerms {
  /** One agent read. */
  readUsdc: number;
  /** One citation. Equal to `readUsdc` when the tenant sets no multiplier. */
  citationUsdc: number;
  x402Network?: string;
}

/**
 * What the three tolled axes mean when the publisher has never answered.
 *
 * Read ONLY where a policy is silent, so a stated policy always wins and an unstated one produces
 * the document byte-for-byte as it was before this module existed. `ai-train` is deliberately
 * ABSENT from this table: its unstated state is not a default at all but a refusal to speak, and
 * giving it an entry here is how it would leak into `<prohibits>` on behalf of a publisher who
 * never said it.
 */
const UNSTATED: Required<Pick<TermsPolicy, "search" | "ai-input" | "ai-index">> = {
  search: "free",
  "ai-input": "priced",
  "ai-index": "priced",
};

/**
 * The licence set a policy produces, in emission order.
 *
 * Free-first is inherited from the hardcoded set this replaced: a processor evaluating all
 * applicable terms together should meet the unpriced grant before the priced one, and a human
 * reading the file should see "search is free" before they see a number. The refusal goes last,
 * where a reader has the permissions in mind to contrast it against.
 */
export function blocksFor(policy: TermsPolicy | undefined, priced: PricedTerms): LicenseBlock[] {
  const stated = policy ?? {};
  const state = { ...UNSTATED, ...stated };
  const blocks: LicenseBlock[] = [];
  const prohibited: string[] = [];
  const free: string[] = [];
  const pricedRead: string[] = [];

  for (const term of ["search", "ai-input", "ai-index"] as const) {
    if (state[term] === "prohibit") prohibited.push(term);
    else if (state[term] === "free") free.push(term);
    else pricedRead.push(term);
  }
  // `ai-train` is read from what the owner STATED, never from `state`, because it has no default.
  // Unstated leaves it out of both lists, which RSL reads as "not explicitly permitted" — the
  // truth, and the position `document.ts` has held since the document existed.
  if (stated["ai-train"] === "free") free.push("ai-train");

  if (free.length > 0) blocks.push({ usage: free, payment: { type: "free" } });
  if (pricedRead.length > 0) {
    blocks.push({
      usage: pricedRead,
      // A read: an agent fetches the page to answer with it now. `crawl` is RSL's per-fetch
      // payment type, which is exactly what the toll charges per request.
      payment: { type: "crawl", amountUsdc: priced.readUsdc },
      ...(priced.x402Network ? { x402Network: priced.x402Network } : {}),
    });
    // A citation is a second priced licence under `use`, and RSL has no citation-shaped usage token,
    // so quoting is still `ai-input`. It is emitted even when it costs the same as a read: a buyer
    // asks for citation rights by posting this licence to the licence server, and one that is not
    // published cannot be asked for. Only while `ai-input` is something this site sells at all.
    if (pricedRead.includes("ai-input")) {
      blocks.push({
        usage: ["ai-input"],
        payment: { type: "use", amountUsdc: priced.citationUsdc },
        ...(priced.x402Network ? { x402Network: priced.x402Network } : {}),
      });
    }
  }
  // Granted, but by negotiation rather than by price. `training` is a real RSL payment type and an
  // amountless payment parses correctly: the sibling drops a non-numeric amount rather than
  // coercing it to zero, so this states "available, ask here" without quoting a number nobody
  // decided. No `<accepts>` rides with it either — a deal is not payable over x402 by definition.
  if (stated["ai-train"] === "by-agreement" && stated.contact) {
    blocks.push({
      usage: ["ai-train"],
      payment: { type: "training" },
      contact: stated.contact,
    });
  }
  if (stated["ai-train"] === "prohibit") prohibited.push("ai-train");
  // No payment element on a refusal. `<payment type="free"/>` beside a prohibition reads as
  // "the thing you may not do costs nothing", which is a claim nobody made; the sibling parser
  // treats a payment-less licence as valid (`sdk/src/rsl/parse.ts`) and resolves the prohibition
  // from `<prohibits>` alone (`terms.ts` `verdict`).
  if (prohibited.length > 0) blocks.push({ usage: [], prohibits: prohibited });
  return blocks;
}
