#!/usr/bin/env node
/**
 * `naulon doctor` — health-check your own gate (the CLI shell around `runDoctor`).
 *
 *   naulon doctor                    # reads ./.env, probes the gate if it's running
 *   naulon doctor --env path/.env    # a different env file
 *   naulon doctor --url http://…     # probe a gate at a specific address
 *   naulon doctor --no-probe         # config-only, don't touch the network
 *
 * Exits non-zero if any check FAILED (warnings don't fail the run).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runDoctor, type DoctorCheck } from "../doctor/doctor.ts";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const GLYPH: Record<DoctorCheck["level"], string> = {
  pass: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  fail: `${RED}✗${RESET}`,
};

interface DoctorFlags {
  envPath: string;
  gateUrl?: string;
  probe: boolean;
  help: boolean;
}

export function parseDoctorFlags(argv: string[]): DoctorFlags {
  const f: DoctorFlags = { envPath: resolve(process.cwd(), ".env"), probe: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--no-probe") f.probe = false;
    else if (a === "--env") f.envPath = resolve(argv[++i] ?? f.envPath);
    else if (a === "--url") f.gateUrl = argv[++i];
  }
  return f;
}

const USAGE = "usage: naulon doctor [--env <path>] [--url <gateUrl>] [--no-probe]";

export async function doctorMain(argv: string[]): Promise<number> {
  const f = parseDoctorFlags(argv);
  if (f.help) {
    console.log(USAGE);
    return 0;
  }

  const outcome = await runDoctor({
    envText: existsSync(f.envPath) ? readFileSync(f.envPath, "utf8") : null,
    fileExists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    cwd: dirname(f.envPath),
    fetchImpl: f.probe ? fetch : undefined,
    gateUrl: f.gateUrl,
  });

  console.log(`\n  ${DIM}naulon doctor — ${f.envPath}${RESET}\n`);
  for (const c of outcome.checks) console.log(`  ${GLYPH[c.level]} ${c.name.padEnd(12)} ${c.detail}`);
  const failed = outcome.checks.filter((c) => c.level === "fail").length;
  const warned = outcome.checks.filter((c) => c.level === "warn").length;
  console.log(
    outcome.ok
      ? `\n  ${GREEN}healthy${RESET}${warned ? ` ${DIM}(${warned} warning${warned === 1 ? "" : "s"})${RESET}` : ""}`
      : `\n  ${RED}${failed} check${failed === 1 ? "" : "s"} failed${RESET} — fix the ✗ above`,
  );
  return outcome.ok ? 0 : 1;
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /doctor\.(ts|js)$/.test(process.argv[1])) {
  void doctorMain(process.argv.slice(2)).then((c) => process.exit(c));
}
