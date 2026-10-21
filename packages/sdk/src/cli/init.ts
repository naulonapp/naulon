#!/usr/bin/env node
/**
 * `naulon init` — the interactive setup wizard (the CLI shell around `buildInitPlan`).
 *
 *   naulon init                 # prompt for everything, sensible defaults in brackets
 *   naulon init --yes           # non-interactive: flags + defaults, nothing asked (CI)
 *   naulon init --mode gateway --origin https://mysite.com --wallet 0x… --yes
 *
 * It writes two files the gate boots from — `.env` and a starter `credits.json` — and
 * refuses to clobber either unless you pass `--force` (the `prisma init` rule). All the
 * value logic lives in `../init/plan.ts`; this file is only prompts + I/O.
 */
import * as readline from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WALLET_RE } from "../contract/wallet.ts";
import { buildInitPlan, initAnswersSchema, INIT_DEFAULTS, type InitAnswers } from "../init/plan.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIAMOND = "◆";

interface Flags {
  yes: boolean;
  force: boolean;
  dir: string;
  help: boolean;
  // answer overrides (undefined → prompt / default)
  originUrl?: string;
  priceUsdc?: string;
  citationMultiplier?: string;
  paymentMode?: string;
  settlementNetwork?: string;
  tollgatePort?: string;
  articlePrefixes?: string;
  creditsPath?: string;
  defaultWallet?: string;
  starterSlug?: string;
  starterTitle?: string;
  starterAuthorId?: string;
  runtime?: string;
}

const FLAG_MAP: Record<string, keyof Flags> = {
  "--origin": "originUrl",
  "--price": "priceUsdc",
  "--citation-multiplier": "citationMultiplier",
  "--mode": "paymentMode",
  "--network": "settlementNetwork",
  "--port": "tollgatePort",
  "--prefixes": "articlePrefixes",
  "--credits": "creditsPath",
  "--wallet": "defaultWallet",
  "--slug": "starterSlug",
  "--title": "starterTitle",
  "--author-id": "starterAuthorId",
  "--runtime": "runtime",
};

export function parseInitFlags(argv: string[]): Flags {
  const f: Flags = { yes: false, force: false, dir: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--force" || a === "-f") f.force = true;
    else if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--dir") f.dir = argv[++i] ?? f.dir;
    else if (a) {
      const key = FLAG_MAP[a];
      if (key) (f as unknown as Record<string, string | undefined>)[key] = argv[++i];
    }
  }
  return f;
}

const USAGE = `usage: naulon init [--yes] [--force] [--dir <path>]
             [--origin <url>] [--price <n>] [--citation-multiplier <n>]
             [--mode mock|gateway] [--network arcTestnet|baseSepolia|base]
             [--port <n>] [--prefixes <csv>] [--credits <path>]
             [--wallet 0x…] [--slug <s>] [--title <t>] [--author-id <id>]
             [--runtime docker|repo]`;

/**
 * A line reader over stdin. Crucially, `next()` returns `null` at end-of-input instead of
 * stranding — so piping a finite stdin (`echo … | naulon init`, or a test) accepts defaults
 * for the rest instead of Node silently exiting 0 with no files written. A real TTY never
 * ends, so interactive use is unaffected.
 */
interface LineReader {
  next(): Promise<string | null>;
  close(): void;
}

function makeReader(): LineReader {
  const rl = readline.createInterface({ input: process.stdin });
  const it = rl[Symbol.asyncIterator]();
  return {
    async next() {
      const { value, done } = await it.next();
      return done ? null : (value as string);
    },
    close() {
      rl.close();
    },
  };
}

/** One prompt: shows the default in brackets, re-asks until the input validates. */
async function ask(
  reader: LineReader,
  label: string,
  def: string,
  validate?: (v: string) => string | null,
): Promise<string> {
  for (;;) {
    process.stdout.write(`  ${DIAMOND} ${label} ${DIM}(${def})${RESET} `);
    const line = await reader.next();
    if (line === null) return def; // input ended → accept the default, don't hang
    const value = line.trim() === "" ? def : line.trim();
    const err = validate?.(value) ?? null;
    if (!err) return value;
    console.log(`    ${DIM}↳ ${err}${RESET}`);
  }
}

const vUrl = (v: string) => {
  try {
    new URL(v);
    return null;
  } catch {
    return "enter a valid URL, e.g. https://mysite.com";
  }
};
const vPositive = (v: string) => (Number(v) > 0 ? null : "enter a number greater than 0");
const vPort = (v: string) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "enter a whole port number");
const vMode = (v: string) => (v === "mock" || v === "gateway" ? null : "enter 'mock' or 'gateway'");
const vNetwork = (v: string) =>
  ["arcTestnet", "baseSepolia", "base"].includes(v) ? null : "arcTestnet | baseSepolia | base";
const vWallet = (v: string) => (v === "" || WALLET_RE.test(v) ? null : "a 0x-prefixed 40-hex address, or blank");
const vNonEmpty = (v: string) => (v.trim() === "" ? "cannot be blank" : null);

/**
 * How the gate in this directory will be started. A clone of the repo runs `make dev`; a
 * directory holding only docker-compose.yml runs the image. The repo also carries a
 * docker-compose.yml, so the clone is checked first.
 */
export function detectRuntime(dir: string): "docker" | "repo" | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    if (pkg.name === "naulon") return "repo";
  } catch {
    // no package.json, or not ours
  }
  return existsSync(join(dir, "docker-compose.yml")) ? "docker" : undefined;
}

/** A first administrator's password: 24 URL-safe characters, 144 bits. */
const generatePassword = (): string => randomBytes(18).toString("base64url");

/** Gather answers from flags + defaults, only prompting for what's missing (unless --yes). */
async function gather(f: Flags, reader: LineReader): Promise<InitAnswers> {
  const runtime = f.runtime === "docker" || f.runtime === "repo" ? f.runtime : detectRuntime(resolve(f.dir));
  // Compose mounts ./config read-only and reads credits from there.
  const d = { ...INIT_DEFAULTS, creditsPath: runtime === "docker" ? "./config/credits.json" : INIT_DEFAULTS.creditsPath };
  const fixed = { runtime, consolePassword: generatePassword() };
  if (f.yes) {
    const mode = (f.paymentMode ?? d.paymentMode) as "mock" | "gateway";
    return initAnswersSchema.parse({
      originUrl: f.originUrl ?? d.originUrl,
      priceUsdc: Number(f.priceUsdc ?? d.priceUsdc),
      citationMultiplier: Number(f.citationMultiplier ?? d.citationMultiplier),
      paymentMode: mode,
      settlementNetwork: f.settlementNetwork ?? d.settlementNetwork,
      tollgatePort: Number(f.tollgatePort ?? d.tollgatePort),
      articlePrefixes: f.articlePrefixes ?? d.articlePrefixes,
      creditsPath: f.creditsPath ?? d.creditsPath,
      starterSlug: f.starterSlug ?? d.starterSlug,
      starterTitle: f.starterTitle ?? d.starterTitle,
      starterAuthorId: f.starterAuthorId ?? d.starterAuthorId,
      defaultWallet: f.defaultWallet && f.defaultWallet !== "" ? f.defaultWallet : undefined,
      ...fixed,
    });
  }

  console.log(`\n${BOLD}naulon init${RESET} ${DIM}— set up your gate. Enter accepts the default.${RESET}\n`);
  const originUrl = await ask(reader, "Your site's origin URL", f.originUrl ?? d.originUrl, vUrl);
  const priceUsdc = await ask(reader, "Read price (USDC)", f.priceUsdc ?? String(d.priceUsdc), vPositive);
  const citationMultiplier = await ask(
    reader,
    "Citation multiplier (× a read)",
    f.citationMultiplier ?? String(d.citationMultiplier),
    vPositive,
  );
  const articlePrefixes = await ask(reader, "Gateable path prefixes (csv)", f.articlePrefixes ?? d.articlePrefixes, vNonEmpty);
  const tollgatePort = await ask(reader, "Tollgate port", f.tollgatePort ?? String(d.tollgatePort), vPort);
  const paymentMode = await ask(reader, "Settlement mode", f.paymentMode ?? d.paymentMode, vMode);
  const settlementNetwork =
    paymentMode === "gateway"
      ? await ask(reader, "Settlement network", f.settlementNetwork ?? d.settlementNetwork, vNetwork)
      : d.settlementNetwork;
  const defaultWallet = await ask(reader, "Default author wallet (blank = placeholder)", f.defaultWallet ?? "", vWallet);
  const starterSlug = await ask(reader, "Starter article slug", f.starterSlug ?? d.starterSlug, vNonEmpty);
  const starterTitle = await ask(reader, "Starter article title", f.starterTitle ?? d.starterTitle, vNonEmpty);

  return initAnswersSchema.parse({
    originUrl,
    priceUsdc: Number(priceUsdc),
    citationMultiplier: Number(citationMultiplier),
    paymentMode,
    settlementNetwork,
    tollgatePort: Number(tollgatePort),
    articlePrefixes,
    creditsPath: f.creditsPath ?? d.creditsPath,
    starterSlug,
    starterTitle,
    starterAuthorId: f.starterAuthorId ?? d.starterAuthorId,
    defaultWallet: defaultWallet === "" ? undefined : defaultWallet,
    ...fixed,
  });
}

export async function initMain(argv: string[]): Promise<number> {
  const f = parseInitFlags(argv);
  if (f.help) {
    console.log(USAGE);
    return 0;
  }

  // One reader for the whole interactive flow (answers + overwrite confirms). --yes uses none.
  const reader = f.yes ? null : makeReader();
  const written: string[] = [];
  const skipped: string[] = [];
  try {
    let answers: InitAnswers;
    try {
      answers = await gather(f, reader ?? { next: async () => null, close: () => {} });
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }

    const plan = buildInitPlan(answers);
    const dir = resolve(f.dir);
    const files = [plan.env, plan.credits];

    // Refuse to clobber. Interactive → confirm per file; --yes → skip unless --force.
    for (const file of files) {
      const abs = join(dir, file.path);
      if (existsSync(abs) && !f.force) {
        let overwrite = false;
        if (reader) {
          process.stdout.write(`  ⚠ ${file.path} exists — overwrite? ${DIM}[y/N]${RESET} `);
          const a = (await reader.next())?.trim().toLowerCase() ?? "";
          overwrite = a === "y" || a === "yes";
        }
        if (!overwrite) {
          skipped.push(file.path);
          continue;
        }
      }
      await mkdir(dirname(abs), { recursive: true });
      // .env carries the console's first password, so only its owner may read it.
      await writeFile(abs, file.contents, { encoding: "utf8", mode: file === plan.env ? 0o600 : 0o644 });
      written.push(file.path);
    }
    printOutcome(written, skipped, plan);
  } finally {
    reader?.close();
  }
  return 0;
}

function printOutcome(written: string[], skipped: string[], plan: ReturnType<typeof buildInitPlan>): void {
  console.log("");
  for (const p of written) console.log(`  ✓ wrote ${p}`);
  for (const p of skipped) console.log(`  ${DIM}• kept ${p} (exists — pass --force to overwrite)${RESET}`);
  for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
  if (written.length > 0) {
    console.log(`\n  ${BOLD}Next:${RESET}`);
    for (const s of plan.nextSteps) console.log(`    → ${s}`);
  }
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /init\.(ts|js)$/.test(process.argv[1])) {
  void initMain(process.argv.slice(2)).then((c) => process.exit(c));
}
