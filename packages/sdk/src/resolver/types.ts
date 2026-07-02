import type { ArticleCredits } from "../contract/credits.ts";

/**
 * Resolves an article slug to its credits graph. This is the seam that makes the
 * toll publisher-agnostic: any site implements one of these (HTTP API, static
 * file, database) and the gate works unchanged. `undefined` = no credits for this
 * slug, which the gate reads as the deliberate "free read" signal.
 */
export interface CreditsResolver {
  resolve(slug: string): Promise<ArticleCredits | undefined>;
}
