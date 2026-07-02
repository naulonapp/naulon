/**
 * The credits graph — the `/credits/:slug` response shape and its validator.
 *
 * `wallet` ultimately comes from whatever a publisher's credits source returns
 * (an HTTP API, a static file, a DB). If that response is malformed or hostile,
 * payments could route to the wrong wallet or crash the gate mid-flow. So every
 * credits object crossing into the system is parsed through `creditsSchema` first:
 * structure is checked, and crucially every leaf `wallet` must be a well-formed
 * 0x address before it can ever become a `payTo`.
 *
 * A contributor is either a leaf (has a `wallet`) or a composite (has non-empty
 * `members` that re-split recursively) — never both, never neither.
 */
import { z } from "zod";
import { walletSchema, type WalletAddress } from "./wallet.ts";

/**
 * The credits graph node for one article. Co-authors may themselves be composites
 * (e.g. a collective that splits again), hence the recursive shape resolved by the
 * gate's attribution layer.
 */
export interface ArticleCredits {
  slug: string;
  title: string;
  /** Direct contributors. Weights are relative; they get normalized to shares. */
  contributors: Contributor[];
}

export interface Contributor {
  authorId: string;
  /** Relative weight of this contributor among siblings (default 1). */
  weight?: number;
  /** A leaf author resolves to a wallet... */
  wallet?: WalletAddress;
  /** ...or a composite re-splits among its own members (recursive). */
  members?: Contributor[];
}

// Recursive: a composite's members are themselves contributors.
const contributorSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      authorId: z.string().min(1),
      weight: z.number().positive().optional(),
      wallet: walletSchema.optional(),
      members: z.array(contributorSchema).min(1).optional(),
    })
    .strict()
    .refine(
      (c) => (c.wallet === undefined) !== (c.members === undefined),
      "a contributor must have exactly one of `wallet` (leaf) or `members` (composite)",
    ),
);

export const creditsSchema = z
  .object({
    slug: z.string().min(1),
    title: z.string().min(1),
    contributors: z.array(contributorSchema).min(1),
  })
  .strict();

/**
 * Parse + validate one credits object. Throws a descriptive error on anything
 * malformed. `context` (e.g. the slug or source URL) is woven into the message
 * so a bad upstream response is traceable.
 */
export function parseCredits(raw: unknown, context = "credits"): ArticleCredits {
  const result = creditsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid ${context}:\n${issues}`);
  }
  return result.data as ArticleCredits;
}

/**
 * A validating builder for publishers producing a credits payload. Runs the same
 * schema as the consume side, so a publisher cannot emit a malformed object that
 * the gate would later reject — the error surfaces at construction instead.
 */
export function buildCredits(input: unknown): ArticleCredits {
  return parseCredits(input, "buildCredits");
}
