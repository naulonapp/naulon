import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * This repo is MIT and published. Nothing in it may name the private control plane that consumes
 * it, or the private reference publisher — not in code, not in a comment, not in a README that
 * ships inside an npm tarball.
 *
 * The dependency points ONE way: private depends on public, never the reverse. A comment naming a
 * private repo, an internal file path, or a migration number is that arrow pointing backwards in
 * public. It also hands a reader the private side's repo name, layout and schema history for free.
 *
 * This existed as a rule and was broken four times anyway — a source comment in `@naulon/shared`,
 * one in `@naulon/wayfarer`, one in a test, and a README that `npm pack` puts on npmjs.com. A rule
 * nothing checks is a comment. This is the check.
 *
 * Describing the hosted service in the abstract is fine and expected ("a control plane built on
 * this core", "the hosted naulon service"). What is banned is the private NAME.
 *
 * Scope is the whole repository, not `packages/`. It walked only `packages/` until 2026-08-05,
 * which left the root README, `docs/` (the published mkdocs site), `examples/`, `scripts/`,
 * `plugins/` and the workflows unguarded — every one of them public, and the docs site more
 * widely read than any tarball. Three of the four original leaks happened to be inside
 * `packages/`; nothing but luck put them there.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** Assembled at runtime so this file does not match its own rule. */
const BANNED: { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(["naulon", "cloud"].join("-"), "i"), what: "the private control-plane repo name" },
  { pattern: new RegExp(["sanctum", "website"].join("-"), "i"), what: "the private reference-publisher repo name" },
  { pattern: new RegExp(["inner", "axiom"].join(""), "i"), what: "the private reference publisher" },
];

const SCANNED = /\.(ts|tsx|js|mjs|cjs|md|json|yml|yaml|php|txt|sh)$/;

/**
 * Build output and third-party trees only. `.git` is skipped because history is not something a
 * test can fix — a name already committed is redacted going forward, never rewritten (this repo
 * does not rewrite history), so failing on it would leave a permanently red suite that teaches
 * people to ignore the guard.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".git",
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCANNED.test(entry)) yield full;
  }
}

test("no published file names the private control plane or the private publisher", () => {
  const offences: string[] = [];

  for (const file of walk(REPO)) {
    if (file === fileURLToPath(import.meta.url)) continue; // this file spells them on purpose
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      for (const { pattern, what } of BANNED) {
        if (pattern.test(line)) {
          offences.push(`${relative(REPO, file)}:${i + 1} names ${what}\n    ${line.trim()}`);
        }
      }
    }
  }

  assert.equal(
    offences.length,
    0,
    `Private names must not appear in this public repo:\n\n${offences.join("\n")}\n\n` +
      `Describe the hosted side in the abstract instead — "a control plane built on this core".`,
  );
});
