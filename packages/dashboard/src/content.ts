/**
 * Content manager — the server side of the console's Content tab. Reads the
 * effective credits, runs the SAME crawl engine the `naulon-kit crawl` CLI uses
 * (one engine, two front-doors — they can't drift), and writes credits.json
 * through the validated, all-or-nothing path (credits-edit.ts) with a .bak.
 *
 * This is the one WRITE surface in the dashboard, and it routes money — the
 * server only mounts it off loopback/authed, never in public mode (see server.ts).
 */
import { readFile, writeFile } from "node:fs/promises";
import { getConfig, type ArticleCredits } from "@naulon/shared";
import { runCrawl, makeGuardedFetcher, type CrawlConfig } from "@naulon/sdk";
import { validateCreditsMap, type CreditsValidation } from "./credits-edit.ts";

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
};

const prefixes = (csv: string): string[] => csv.split(",").map((p) => p.trim()).filter(Boolean);

export interface ContentState {
  /** true when credits come from a live API — the local file manager doesn't apply. */
  apiMode: boolean;
  origin: string;
  articlePrefixes: string[];
  creditsPath: string;
  /** The current credits.json map (raw, editable). Empty in API mode. */
  credits: Record<string, unknown>;
}

export async function readContent(): Promise<ContentState> {
  const c = getConfig();
  const apiMode = !!c.CREDITS_API_URL;
  let credits: Record<string, unknown> = {};
  if (!apiMode) {
    try {
      const parsed = JSON.parse(await readFile(c.CREDITS_FIXTURES, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") credits = parsed as Record<string, unknown>;
    } catch {
      // no file yet → empty, the operator starts from a scan or a manual add.
    }
  }
  return { apiMode, origin: c.ORIGIN_URL, articlePrefixes: prefixes(c.ARTICLE_PATH_PREFIXES), creditsPath: c.CREDITS_FIXTURES, credits };
}

export interface ScanResult {
  adapterId: string | null;
  discovered: number;
  added: string[];
  keptExisting: string[];
  /** Discovered but no wallet — the operator's to-do (slug + the feed author string). */
  unmapped: { slug: string; author: string | null }[];
  /** existing + newly-mapped articles, ready to drop into the editor. */
  credits: Record<string, ArticleCredits>;
}

export async function scanArticles(defaultWallet?: string): Promise<ScanResult> {
  const c = getConfig();
  const origin = c.ORIGIN_URL;
  const existing = (await readContent()).credits as Record<string, ArticleCredits>;
  const config: CrawlConfig = {
    includeGlobs: [],
    excludeGlobs: [],
    authorWalletMap: {},
    ...(defaultWallet ? { defaultWallet } : {}),
  };
  const fetch = makeGuardedFetcher({ origin, allowPrivate: isLoopbackOrigin(origin) });
  const r = await runCrawl({ origin, articlePrefixes: prefixes(c.ARTICLE_PATH_PREFIXES), config, existing, fetch });
  return {
    adapterId: r.adapterId,
    discovered: r.discovered,
    added: r.added,
    keptExisting: r.keptExisting,
    unmapped: r.unmapped,
    credits: r.credits,
  };
}

export interface WriteResult extends CreditsValidation {
  written: boolean;
  path?: string;
  backup?: string;
}

/**
 * Validate the FULL desired map, then (only if every entry is valid) back up the
 * current file to `.bak` and write. All-or-nothing: a bad wallet writes nothing.
 */
export async function writeCredits(rawMap: Record<string, unknown>): Promise<WriteResult> {
  const c = getConfig();
  if (c.CREDITS_API_URL) {
    return { ok: false, written: false, errors: [{ slug: "*", message: "credits come from a live API — edit them at your CMS, not here." }], unmapped: [] };
  }
  const v = validateCreditsMap(rawMap);
  if (!v.ok || !v.credits) return { ...v, written: false };

  const path = c.CREDITS_FIXTURES;
  try {
    const current = await readFile(path, "utf8");
    await writeFile(`${path}.bak`, current, "utf8"); // recoverable before overwrite
  } catch {
    // no existing file to back up — first write.
  }
  await writeFile(path, JSON.stringify(v.credits, null, 2) + "\n", "utf8");
  return { ...v, written: true, path, backup: `${path}.bak` };
}
