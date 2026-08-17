import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Every `@naulon/*` dependency range inside this workspace must be satisfiable by the version
 * that package carries in THIS tree.
 *
 * The trap this exists for is specific to `0.x`, and it is silent. A caret range on a
 * zero-major is minor-tight: `^0.1.2` resolves `0.1.9` and refuses `0.2.0`. So the moment
 * `@naulon/shared` goes 0.1.2 → 0.2.0, a dependent still asking for `^0.1.2` does not fail —
 * npm quietly installs the OLD shared beside the new one, and the consumer runs a version pair
 * that was never tested together. Inside the workspace nothing surfaces it either: npm links the
 * local copy regardless of range, so the tree stays green while the published graph is broken.
 *
 * Only an installing consumer would ever see it, which is the worst place to find out.
 *
 * Unpublished workspace-internal packages use `*` and are exempt — they are never resolved from
 * a registry. The exemption is on the DEPENDENT being private, not on the string `*` itself: a
 * PUBLISHED package asking for `*` ships a range that resolves whatever is newest at install time,
 * including a future breaking minor it was never tested against. `@naulon/enforce` acquired exactly
 * that (`"@naulon/sdk": "*"`, added when the article-key rule moved into the SDK) and this guard
 * waved it through, because it only ever asked what the range said.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

type Pkg = { name: string; version: string; private?: boolean; dependencies?: Record<string, string> };

function readPackages(): Map<string, { pkg: Pkg; dir: string }> {
  const out = new Map<string, { pkg: Pkg; dir: string }>();
  for (const entry of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, entry, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Pkg;
    out.set(pkg.name, { pkg, dir: entry });
  }
  return out;
}

/**
 * Caret semantics, the only range form used here. Implemented rather than pulled in: `semver` is
 * not a dependency of this workspace, and a guard that needs an install is a guard that can go
 * missing in the one job that matters.
 */
export function caretSatisfies(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return false;
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) return false;
  const [, rMaj, rMin, rPatch] = m.map(Number) as [number, number, number, number];
  const [, vMaj, vMin, vPatch] = v.map(Number) as [number, number, number, number];

  if (vMaj !== rMaj) return false;
  // A zero-major pins the minor: ^0.1.2 means >=0.1.2 <0.2.0.
  if (rMaj === 0 && vMin !== rMin) return false;
  if (vMin !== rMin) return vMin > rMin;
  return vPatch >= rPatch;
}

/**
 * The rule itself, over a package map rather than over the filesystem — so the negative cases can
 * be asserted against a synthetic tree. A guard whose only test is "the real repo is fine today"
 * passes just as happily when the check has stopped checking anything.
 */
export function rangeOffences(packages: Map<string, { pkg: Pkg; dir: string }>): string[] {
  const offences: string[] = [];

  for (const [name, { pkg, dir }] of packages) {
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@naulon/")) continue;
      if (range === "*") {
        // Fine from a private package — nothing installs it, so nothing resolves the range.
        if (pkg.private) continue;
        offences.push(
          `packages/${dir}/package.json: ${name} is PUBLISHED and wants ${dep}@*, which resolves ` +
            `whatever is newest at install time. Pin it to the caret range of the version in this tree.`,
        );
        continue;
      }
      const target = packages.get(dep);
      if (!target) {
        offences.push(`packages/${dir}/package.json depends on ${dep}, which is not in this workspace`);
        continue;
      }
      if (!caretSatisfies(range, target.pkg.version)) {
        offences.push(
          `packages/${dir}/package.json: ${name} wants ${dep}@${range}, ` +
            `but ${dep} is ${target.pkg.version} in this tree`,
        );
      }
    }
  }

  return offences;
}

test("every internal @naulon/* range resolves the version in this tree", () => {
  const offences = rangeOffences(readPackages());

  assert.equal(
    offences.length,
    0,
    `Internal dependency ranges are out of step with the versions they point at:\n\n${offences.join("\n")}\n\n` +
      `On a 0.x version a caret is minor-tight — ^0.1.2 will not take 0.2.0. Bump the range in the ` +
      `same change as the version, or a consumer installs a mismatched pair.`,
  );
});

test("a `*` range is exempt from a private package and an offence from a published one", () => {
  const tree = (dependentIsPrivate: boolean) =>
    new Map([
      ["@naulon/sdk", { pkg: { name: "@naulon/sdk", version: "0.2.0" }, dir: "sdk" }],
      [
        "@naulon/dependent",
        {
          pkg: {
            name: "@naulon/dependent",
            version: "1.0.0",
            ...(dependentIsPrivate ? { private: true } : {}),
            dependencies: { "@naulon/sdk": "*" },
          },
          dir: "dependent",
        },
      ],
    ]);

  // tollgate/dashboard/attribution: never installed from a registry, so the range never resolves.
  assert.deepEqual(rangeOffences(tree(true)), []);

  // enforce's shape. `*` takes the next breaking minor of a 0.x package sight unseen.
  const published = rangeOffences(tree(false));
  assert.equal(published.length, 1);
  assert.match(published[0]!, /is PUBLISHED and wants @naulon\/sdk@\*/);
});

test("caretSatisfies pins the minor on a zero-major and floats it above", () => {
  // The exact case that shipped broken: shared moved to 0.2.0 under a ^0.1.2 dependent.
  assert.equal(caretSatisfies("^0.1.2", "0.2.0"), false);
  assert.equal(caretSatisfies("^0.1.2", "0.1.2"), true);
  assert.equal(caretSatisfies("^0.1.2", "0.1.9"), true);
  assert.equal(caretSatisfies("^0.1.2", "0.1.1"), false);
  assert.equal(caretSatisfies("^0.2.0", "0.2.0"), true);
  // Above zero a caret floats the minor, which is why the rule cannot simply be "minors must match".
  assert.equal(caretSatisfies("^1.2.0", "1.3.0"), true);
  assert.equal(caretSatisfies("^1.2.0", "2.0.0"), false);
  assert.equal(caretSatisfies("^1.2.0", "1.1.9"), false);
  // Anything that is not a plain caret is not a range this workspace knows how to vouch for.
  assert.equal(caretSatisfies("~0.1.2", "0.1.2"), false);
  assert.equal(caretSatisfies("*", "0.1.2"), false);
});
