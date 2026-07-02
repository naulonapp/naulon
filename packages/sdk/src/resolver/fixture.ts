/**
 * Static credits resolvers — a JSON map (great for local dev + demos) or a file.
 * Every entry is validated at load, so a malformed fixture fails fast rather than
 * mid-payment.
 */
import { readFile } from "node:fs/promises";
import { parseCredits, type ArticleCredits } from "../contract/credits.ts";
import type { CreditsResolver } from "./types.ts";

export function fixtureResolver(fixtures: Record<string, ArticleCredits>): CreditsResolver {
  return {
    async resolve(slug) {
      return fixtures[slug];
    },
  };
}

/**
 * Load a fixture file lazily; missing file => empty map (gate stays open). Every
 * entry is validated at load, so a malformed fixture fails fast at boot rather
 * than mid-payment.
 */
export async function fixtureResolverFromFile(path: string): Promise<CreditsResolver> {
  let fixtures: Record<string, ArticleCredits> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    fixtures = Object.fromEntries(
      Object.entries(raw).map(([slug, credits]) => [slug, parseCredits(credits, `fixture "${slug}"`)]),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.warn(`[sdk] no credits fixtures at ${path} — articles will pass through ungated.`);
  }
  return fixtureResolver(fixtures);
}
