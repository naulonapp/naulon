#!/usr/bin/env node
/**
 * `naulon selftest` — drive your gate through a whole toll (the CLI shell around `runSelftest`).
 *
 *   naulon selftest                      # reads ./.env, tests the first article in your credits
 *   naulon selftest --slug my-essay      # a specific article
 *   naulon selftest --url http://…       # a gate at another address
 *   naulon selftest --env path/.env      # a different env file
 *   naulon selftest --no-citation        # read leg only
 *
 * Where `doctor` stops at "the gate issues a 402", this pays it, reads the article, checks the
 * licence, and proves the payment cannot be replayed. Exits non-zero if any step FAILED.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runSelftest, type SelftestStep } from "../selftest/selftest.ts";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const GLYPH: Record<SelftestStep["level"], string> = {
  pass: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  fail: `${RED}✗${RESET}`,
};

interface SelftestFlags {
  envPath: string;
  gateUrl?: string;
  slug?: string;
  citation: boolean;
  help: boolean;
}

export function parseSelftestFlags(argv: string[]): SelftestFlags {
  const f: SelftestFlags = { envPath: resolve(process.cwd(), ".env"), citation: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--no-citation") f.citation = false;
    else if (a === "--env") f.envPath = resolve(argv[++i] ?? f.envPath);
    else if (a === "--url") f.gateUrl = argv[++i];
    else if (a === "--slug") f.slug = argv[++i];
  }
  return f;
}

const USAGE = "usage: naulon selftest [--slug <slug>] [--url <gateUrl>] [--env <path>] [--no-citation]";

export async function selftestMain(argv: string[]): Promise<number> {
  const f = parseSelftestFlags(argv);
  if (f.help) {
    console.log(USAGE);
    return 0;
  }

  const outcome = await runSelftest({
    envText: existsSync(f.envPath) ? readFileSync(f.envPath, "utf8") : null,
    fileExists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    cwd: dirname(f.envPath),
    fetchImpl: fetch,
    gateUrl: f.gateUrl,
    slug: f.slug,
    skipCitation: !f.citation,
  });

  console.log(`\n  ${DIM}naulon selftest — ${outcome.url ?? f.envPath}${RESET}\n`);
  for (const s of outcome.steps) console.log(`  ${GLYPH[s.level]} ${s.name.padEnd(10)} ${s.detail}`);

  const failed = outcome.steps.filter((s) => s.level === "fail").length;
  const warned = outcome.steps.filter((s) => s.level === "warn").length;
  if (outcome.ok) {
    // Printed in atomic units, not dollars, because that is what the gate quoted and what the
    // ledger recorded — converting here would be a second opinion about money.
    const authorized = outcome.paidAtomic > 0n ? ` ${DIM}· ${outcome.paidAtomic} atomic USDC authorized (mock — nothing moved)${RESET}` : "";
    console.log(`\n  ${GREEN}the loop clears${RESET}${warned ? ` ${DIM}(${warned} warning${warned === 1 ? "" : "s"})${RESET}` : ""}${authorized}`);
  } else {
    console.log(`\n  ${RED}${failed} step${failed === 1 ? "" : "s"} failed${RESET} — fix the ✗ above`);
  }
  return outcome.ok ? 0 : 1;
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /selftest\.(ts|js)$/.test(process.argv[1])) {
  void selftestMain(process.argv.slice(2)).then((c) => process.exit(c));
}
