import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Every PUBLISHED package must carry the metadata npm renders on its page.
 *
 * The npm page is the whole shopfront for four of these five packages — nobody arrives at
 * `@naulon/wayfarer-mcp` through this README. On 2026-08-28 all five were live with **no
 * `keywords` at all**, checked against the registry rather than the source, so npm search
 * returned nothing for `x402`, `usdc`, `paywall`, `ai-crawler` or `mcp` — the exact words
 * someone looking for this types. Four of the five had shipped that way for months, and the
 * only reason it surfaced is that a human went looking.
 *
 * `releaseRanges.test.ts` beside this file guards the graph a consumer INSTALLS. This one
 * guards what a consumer FINDS and reads before installing anything. Same failure mode in both:
 * silent, invisible in-tree, and only ever visible to someone outside.
 *
 * PRIVATE packages are exempt on purpose — `tollgate` ships as a Docker image, `dashboard` and
 * `attribution` are workspace-internal, and demanding a shopfront for something with no shop is
 * how a guard teaches people to add noise to satisfy it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

/** A README shorter than this is a stub — npm renders it as the whole page. */
const MIN_README_BYTES = 400;
/** Enough terms that a search can actually match one; fewer is decoration. */
const MIN_KEYWORDS = 3;

interface Pkg {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  keywords?: string[];
  license?: string;
  homepage?: string;
  bugs?: unknown;
  engines?: Record<string, string>;
  files?: string[];
  exports?: unknown;
  repository?: { type?: string; url?: string; directory?: string };
}

function published(): Array<{ pkg: Pkg; dir: string }> {
  const out: Array<{ pkg: Pkg; dir: string }> = [];
  for (const entry of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, entry, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Pkg;
    if (pkg.private) continue;
    out.push({ pkg, dir: entry });
  }
  return out;
}

const PUBLISHED = published();

test("there are published packages to check (this file must not pass vacuously)", () => {
  assert.ok(PUBLISHED.length >= 5, `expected the five published packages, found ${PUBLISHED.length}`);
});

for (const { pkg, dir } of PUBLISHED) {
  test(`${pkg.name} carries the metadata npm renders`, () => {
    const missing: string[] = [];

    if (!pkg.description || pkg.description.length < 30) missing.push("description (≥30 chars)");
    if (!Array.isArray(pkg.keywords) || pkg.keywords.length < MIN_KEYWORDS) {
      missing.push(`keywords (≥${MIN_KEYWORDS} — this is how npm search finds the package at all)`);
    }
    if (pkg.license !== "MIT") missing.push('license: "MIT"');
    if (!pkg.homepage) missing.push("homepage");
    if (!pkg.bugs) missing.push("bugs");
    if (!pkg.engines?.node) missing.push("engines.node");
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) missing.push("files (or the tarball ships the repo)");
    if (!pkg.exports) missing.push("exports");
    if (!pkg.repository?.url) missing.push("repository.url");
    // `directory` is what gives npm the per-package source link in a monorepo; without it the
    // link lands on the repo root and a reader has to go hunting.
    if (!pkg.repository?.directory) missing.push("repository.directory");

    const readme = join(PACKAGES, dir, "README.md");
    if (!existsSync(readme)) missing.push("README.md");
    else if (statSync(readme).size < MIN_README_BYTES) {
      missing.push(`README.md ≥${MIN_README_BYTES} bytes (npm renders it as the entire page; it is ${statSync(readme).size})`);
    }

    assert.deepEqual(
      missing,
      [],
      `packages/${dir}/package.json is missing what npm shows a stranger:\n  - ${missing.join("\n  - ")}`,
    );
  });
}
