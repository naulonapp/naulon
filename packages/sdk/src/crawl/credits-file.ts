/**
 * crawl/credits-file.ts — merge discovered articles into a `credits.json` map.
 *
 * The credits file is a `{ [slug]: ArticleCredits }` map (the same shape `naulon init`
 * writes and the gate reads via `CREDITS_FIXTURES`). Merging obeys two hard rules:
 *
 *   1. INSERT-ONLY BY SLUG. A slug already in the file is a human decision — a hand-edited
 *      title, a curated co-author split. A re-crawl NEVER clobbers it. Only genuinely-new
 *      slugs are added. (Mirrors the hosted crawler's `(tenant, slug)` insert-only stage.)
 *
 *   2. MONEY IS NEVER INFERRED. An article whose author resolves to no valid wallet
 *      (`authorWalletMap` miss + no `defaultWallet`) is NOT written — it is reported back
 *      so the operator can map the author, then re-crawl. A drafted entry always has a
 *      human-supplied wallet; the crawler never guesses an address.
 *
 * Every drafted entry is validated through the real `creditsSchema` before it lands, so the
 * crawler can never emit a file the gate would reject at boot.
 */
import { parseCredits, type ArticleCredits } from "../contract/credits.ts";
import { walletAddress } from "../contract/wallet.ts";
import { resolveAuthorWallet } from "./authors.ts";
import type { CrawlConfig, DiscoveredArticle } from "./types.ts";

/** An article the crawler found but could not draft, because no wallet mapped to its author. */
export interface UnmappedArticle {
  slug: string;
  /** The feed author string that had no mapping, or null when the source stated none. */
  author: string | null;
}

export interface MergeResult {
  /** The merged map — existing entries untouched, new mapped articles added. */
  credits: Record<string, ArticleCredits>;
  /** Slugs newly drafted this merge. */
  added: string[];
  /** Slugs skipped because they already existed (insert-only). */
  keptExisting: string[];
  /** Articles skipped because no wallet mapped (money never inferred) — the operator's to-do. */
  unmapped: UnmappedArticle[];
}

/** Merge discovered articles into an existing credits map. Pure — no I/O. */
export function mergeCredits(
  existing: Record<string, ArticleCredits>,
  discovered: DiscoveredArticle[],
  config: CrawlConfig,
): MergeResult {
  const credits: Record<string, ArticleCredits> = { ...existing };
  const added: string[] = [];
  const keptExisting: string[] = [];
  const unmapped: UnmappedArticle[] = [];

  for (const article of discovered) {
    // (1) insert-only — never overwrite a human-owned entry.
    if (Object.prototype.hasOwnProperty.call(existing, article.slug)) {
      keptExisting.push(article.slug);
      continue;
    }
    // (2) money never inferred — no valid wallet ⇒ report, don't write.
    const resolved = resolveAuthorWallet(article, config);
    if (resolved.unmapped || resolved.wallet === null) {
      unmapped.push({ slug: article.slug, author: resolved.author });
      continue;
    }
    const entry: ArticleCredits = {
      slug: article.slug,
      title: article.title.trim() || article.slug, // sitemaps carry no title → the slug is a fair draft
      contributors: [{ authorId: resolved.author?.trim() || "author", wallet: walletAddress(resolved.wallet) }],
    };
    // Never emit a file the gate would reject — validate through the real contract.
    parseCredits(entry, `crawled credits for "${article.slug}"`);
    credits[article.slug] = entry;
    added.push(article.slug);
  }

  return { credits, added, keptExisting, unmapped };
}
