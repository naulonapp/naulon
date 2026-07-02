#!/usr/bin/env node
/**
 * `naulon crawl` — draft a `credits.json` by reading your own origin (the CLI shell).
 *
 *   naulon crawl                         # read origin/prefixes/credits from ./.env
 *   naulon crawl https://mysite.com --prefixes essays,posts --default-wallet 0x…
 *   naulon crawl --adapter rss --feed-url https://mysite.com/feed.xml
 *   naulon crawl --dry-run               # report what it WOULD add, write nothing
 *
 * It probes on-origin, no-secret sources (WordPress REST / RSS / sitemap), derives the gate's
 * credits-key slugs, and inserts NEW articles into your credits map. Two hard rules:
 *   • insert-only — it never overwrites a slug you've already curated;
 *   • money is never inferred — an article whose author maps to no wallet is REPORTED, not
 *     written. Map the author (authorWalletMap / --default-wallet), then re-crawl.
 *
 * All value logic lives in `../crawl/*`; this file is only flags + I/O + the printed summary.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ArticleCredits } from "../contract/credits.ts";
import { parseEnvFile } from "../doctor/doctor.ts";
import { runCrawl } from "../crawl/crawl.ts";
import { makeGuardedFetcher } from "../crawl/fetcher.ts";
import type { CrawlConfig, SourceAdapterId } from "../crawl/types.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface CrawlFlags {
  origin?: string;
  prefixes?: string;
  creditsPath?: string;
  defaultWallet?: string;
  feedUrl?: string;
  adapter?: string;
  allowPrivate: boolean;
  dryRun: boolean;
  dir: string;
  envPath?: string;
  help: boolean;
}

const VALUE_FLAGS: Record<string, keyof CrawlFlags> = {
  "--origin": "origin",
  "--prefixes": "prefixes",
  "--credits": "creditsPath",
  "--default-wallet": "defaultWallet",
  "--feed-url": "feedUrl",
  "--adapter": "adapter",
  "--dir": "dir",
  "--env": "envPath",
};

export function parseCrawlFlags(argv: string[]): CrawlFlags {
  const f: CrawlFlags = { allowPrivate: false, dryRun: false, dir: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "--allow-private") f.allowPrivate = true;
    else if (a === "--dry-run" || a === "-n") f.dryRun = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (VALUE_FLAGS[a]) (f as unknown as Record<string, string | undefined>)[VALUE_FLAGS[a]!] = argv[++i];
    else if (!a.startsWith("-") && f.origin === undefined) f.origin = a; // positional origin
  }
  return f;
}

const ADAPTER_IDS: readonly SourceAdapterId[] = ["rss", "sitemap", "wordpress"];

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return u.protocol === "http:" && (h === "localhost" || h === "127.0.0.1" || h === "::1");
  } catch {
    return false;
  }
}

export interface CrawlPlan {
  origin: string;
  articlePrefixes: string[];
  creditsPath: string;
  config: CrawlConfig;
  existing: Record<string, ArticleCredits>;
  allowPrivate: boolean;
  forceAdapterId?: SourceAdapterId;
}

/** Resolve everything the crawl needs from flags + `.env` + the current credits file. Pure. */
export function planCrawlInputs(
  flags: CrawlFlags,
  env: Record<string, string>,
  existingRaw: string | null,
): CrawlPlan {
  const origin = flags.origin ?? env["ORIGIN_URL"];
  if (!origin) {
    throw new Error("no origin — pass one (`naulon crawl https://mysite.com`) or set ORIGIN_URL in .env");
  }
  const prefixesCsv = flags.prefixes ?? env["ARTICLE_PATH_PREFIXES"];
  if (!prefixesCsv) {
    throw new Error("no article prefixes — pass --prefixes essays,posts or set ARTICLE_PATH_PREFIXES in .env");
  }
  const articlePrefixes = prefixesCsv.split(",").map((p) => p.trim()).filter(Boolean);
  const creditsPath = flags.creditsPath ?? env["CREDITS_FIXTURES"] ?? "./credits.json";

  if (flags.adapter && !ADAPTER_IDS.includes(flags.adapter as SourceAdapterId)) {
    throw new Error(`unknown adapter '${flags.adapter}' — one of: ${ADAPTER_IDS.join(", ")}`);
  }

  let existing: Record<string, ArticleCredits> = {};
  if (existingRaw !== null && existingRaw.trim() !== "") {
    const parsed = JSON.parse(existingRaw) as unknown;
    if (parsed && typeof parsed === "object") existing = parsed as Record<string, ArticleCredits>;
  }

  const config: CrawlConfig = {
    includeGlobs: [],
    excludeGlobs: [],
    authorWalletMap: {},
    ...(flags.defaultWallet ? { defaultWallet: flags.defaultWallet } : {}),
    ...(flags.feedUrl ? { feedUrl: flags.feedUrl } : {}),
  };

  return {
    origin,
    articlePrefixes,
    creditsPath,
    config,
    existing,
    allowPrivate: flags.allowPrivate || isLoopbackOrigin(origin),
    ...(flags.adapter ? { forceAdapterId: flags.adapter as SourceAdapterId } : {}),
  };
}

const USAGE = `usage: naulon crawl [origin] [--prefixes <csv>] [--credits <path>]
              [--default-wallet 0x…] [--feed-url <url>] [--adapter rss|sitemap|wordpress]
              [--dry-run] [--allow-private] [--dir <path>] [--env <path>]

Drafts a credits.json from your own origin. Reads ORIGIN_URL / ARTICLE_PATH_PREFIXES /
CREDITS_FIXTURES from ./.env when the flags are omitted, so \`naulon crawl\` just works
after \`naulon init\`. Insert-only (never overwrites a curated slug); an article whose
author maps to no wallet is reported, never written (money is never inferred).`;

export async function crawlMain(argv: string[]): Promise<number> {
  const f = parseCrawlFlags(argv);
  if (f.help) {
    console.log(USAGE);
    return 0;
  }

  const dir = resolve(f.dir);
  const envPath = f.envPath ? resolve(f.envPath) : join(dir, ".env");
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};

  let plan: CrawlPlan;
  try {
    // Resolve the credits path first (may be relative to the env dir), then read it if present.
    const flags = f;
    const creditsHint = flags.creditsPath ?? env["CREDITS_FIXTURES"] ?? "./credits.json";
    const creditsAbs = isAbsolute(creditsHint) ? creditsHint : join(envPath ? dirname(envPath) : dir, creditsHint);
    const existingRaw = existsSync(creditsAbs) ? readFileSync(creditsAbs, "utf8") : null;
    plan = planCrawlInputs(flags, env, existingRaw);
    // Stash the absolute write target on the plan-adjacent closure.
    return await execute(plan, creditsAbs, f.dryRun);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function execute(plan: CrawlPlan, creditsAbs: string, dryRun: boolean): Promise<number> {
  const fetch = makeGuardedFetcher({ origin: plan.origin, allowPrivate: plan.allowPrivate });

  console.log(`\n  ${BOLD}naulon crawl${RESET} ${DIM}— ${plan.origin}${RESET}`);
  const result = await runCrawl({
    origin: plan.origin,
    articlePrefixes: plan.articlePrefixes,
    config: plan.config,
    existing: plan.existing,
    fetch,
    ...(plan.forceAdapterId ? { forceAdapterId: plan.forceAdapterId } : {}),
  });

  if (result.adapterId === null) {
    console.log(`  ${DIM}no source detected (tried WordPress REST, RSS, sitemap).${RESET}`);
    console.log(`  ${DIM}↳ if your feed is at a non-standard path, pass --feed-url.${RESET}\n`);
    return 1;
  }

  console.log(`  ${DIM}source: ${result.adapterId} · discovered ${result.discovered} · new ${result.added.length} · kept ${result.keptExisting.length} · unmapped ${result.unmapped.length}${RESET}\n`);

  for (const slug of result.added) console.log(`  ✓ ${slug}`);
  if (result.unmapped.length > 0) {
    console.log(`\n  ${BOLD}Needs a wallet${RESET} ${DIM}(not written — money is never guessed):${RESET}`);
    for (const u of result.unmapped) {
      console.log(`  ⚠ ${u.slug} ${DIM}— author ${u.author ? `"${u.author}"` : "(none stated)"}${RESET}`);
    }
    console.log(`  ${DIM}↳ map them in credits.json, or re-run with --default-wallet 0x…${RESET}`);
  }

  if (dryRun) {
    console.log(`\n  ${DIM}--dry-run: nothing written.${RESET}\n`);
    return 0;
  }

  if (result.added.length === 0) {
    console.log(`\n  ${DIM}nothing new to write — ${creditsAbs} unchanged.${RESET}\n`);
    return 0;
  }

  await writeFile(creditsAbs, JSON.stringify(result.credits, null, 2) + "\n", "utf8");
  console.log(`\n  ✓ wrote ${result.added.length} new ${result.added.length === 1 ? "entry" : "entries"} to ${creditsAbs}\n`);
  return 0;
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /crawl\.(ts|js)$/.test(process.argv[1])) {
  void crawlMain(process.argv.slice(2)).then((c) => process.exit(c));
}
