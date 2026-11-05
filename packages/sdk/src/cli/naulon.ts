#!/usr/bin/env node
/**
 * `naulon` — the setup CLI entry point. Dispatches to a subcommand.
 *
 *   naulon init        set up a gate (writes .env + a starter credits.json)
 *   naulon check       conformance-check a credits endpoint (was `naulon-kit check`)
 *
 * Kept as one thin dispatcher so `naulon-kit check …` (the historical bin) still works
 * unchanged — both bins point here.
 */
import { checkMain } from "./check.ts";
import { initMain } from "./init.ts";
import { doctorMain } from "./doctor.ts";
import { crawlMain } from "./crawl.ts";
import { selftestMain } from "./selftest.ts";

const HELP = `naulon — the citation-toll setup CLI

usage: naulon <command> [options]

commands:
  init     set up a gate: writes .env + a starter credits.json  (--yes for non-interactive)
  crawl    draft credits.json from your own origin (WordPress/RSS/sitemap)  (--dry-run)
  doctor   health-check your own gate (env + credits + live human/agent probe)
  selftest drive one whole toll through your gate: quote → pay → read → licence → replay
  check    conformance-check a publisher's /credits endpoint     (baseUrl --slug <s>)
  connect  connect a site you run to its gate, from beside the app  (--site <url>)

run \`naulon <command> --help\` for command options.`;

/**
 * `connect` lives with the runtime that answers the gate (`@naulon/enforce`), which depends on this
 * package, so it is loaded when asked for rather than imported: the dependency still points one way.
 */
async function connectMain(args: string[]): Promise<number> {
  const name = "@naulon/enforce/cli";
  let mod: { connectMain: (a: string[]) => Promise<number> };
  try {
    mod = (await import(name)) as typeof mod;
  } catch {
    console.error("naulon connect needs @naulon/enforce, the package your app serves naulon with: npm install @naulon/enforce");
    return 1;
  }
  return mod.connectMain(args);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return initMain(rest);
    case "crawl":
      return crawlMain(rest);
    case "doctor":
      return doctorMain(rest);
    case "selftest":
      return selftestMain(rest);
    case "check":
      return checkMain(rest);
    case "connect":
      return connectMain(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      return 2;
  }
}

void main().then((c) => process.exit(c));
