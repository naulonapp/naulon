/**
 * Credits-graph validation now lives in @naulon/sdk — the one place the
 * money-routing trust boundary's schema is defined. Re-exported here so existing
 * `@naulon/shared` importers (and `shared/index.ts`'s barrel) are unchanged.
 */
export { creditsSchema, parseCredits, buildCredits } from "@naulon/sdk";
