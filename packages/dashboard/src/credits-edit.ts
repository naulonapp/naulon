/**
 * Credits editing — the money-routing write path behind the console's content
 * manager. The manager sends the FULL desired credits map; this validates EVERY
 * entry through the same schema the gate uses (parseCredits) before anything is
 * written. All-or-nothing: one bad wallet rejects the whole save, so a typo can
 * never half-write a payout map. Pure — the server owns the file + backup I/O.
 */
import { parseCredits, type ArticleCredits } from "@naulon/shared";

export interface CreditsValidation {
  ok: boolean;
  /** The validated, write-ready map — present only when ok. */
  credits?: Record<string, ArticleCredits>;
  /** Per-slug validation failures — present when not ok. */
  errors: { slug: string; message: string }[];
  /** Slugs whose authors resolve to a wallet vs not (money-safety surfacing). */
  unmapped: string[];
}

/** A wallet is required and must look like a 20-byte hex address. */
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Walk a raw credits entry for any contributor (incl. nested `members`) that has
 * no wallet — the one thing a scraper can't supply. Reported, never guessed.
 */
function hasUnmappedAuthor(entry: unknown): boolean {
  const contributors = (entry as { contributors?: unknown })?.contributors;
  if (!Array.isArray(contributors)) return false;
  const walk = (c: unknown): boolean => {
    const node = c as { wallet?: unknown; members?: unknown };
    if (Array.isArray(node.members)) return node.members.some(walk);
    return typeof node.wallet !== "string" || !WALLET_RE.test(node.wallet);
  };
  return contributors.some(walk);
}

export function validateCreditsMap(raw: Record<string, unknown>): CreditsValidation {
  const credits: Record<string, ArticleCredits> = {};
  const errors: { slug: string; message: string }[] = [];
  const unmapped: string[] = [];

  for (const [slug, entry] of Object.entries(raw)) {
    if (hasUnmappedAuthor(entry)) unmapped.push(slug);
    try {
      credits[slug] = parseCredits(entry, `article "${slug}"`);
    } catch (e) {
      errors.push({ slug, message: (e as Error).message.split("\n").slice(0, 3).join(" ").trim() });
    }
  }

  return errors.length > 0
    ? { ok: false, errors, unmapped }
    : { ok: true, credits, errors: [], unmapped };
}
