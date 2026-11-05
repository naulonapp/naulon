#!/usr/bin/env node
// Release series: which tag ships what, and whether each unit's version moved with its code.
//
// Two tag series publish from this repository, each to its own registry:
//
//   v*         the npm packages (PUBLISHED_PACKAGES in .github/workflows/release.yml) and the
//              WordPress plugin, which rides the same tag to wordpress.org
//   python-v*  the `naulon` package on PyPI, behind the `pypi` environment
//
// A series is compared only against the previous tag OF ITS OWN SERIES. `git describe --tags`
// without a pattern returns the nearest tag of any series, so a python-v* tag would otherwise
// become the npm baseline and hide every change made before it.
//
//   node scripts/release.mjs status [--github]   which series have unreleased changes (exit 0)
//   node scripts/release.mjs check <tag>         a tag's units all moved their version (exit 1 if not)
//
// `status` is the signal that a release is owed; `check` is the gate a tag must pass before
// anything irreversible is published.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

/** Whether `pathspec` differs between two refs. Exit 1 means "differs"; anything else is an error. */
function differs(cwd, from, to, pathspec) {
  const run = spawnSync("git", ["diff", "--quiet", from, to, "--", ...pathspec], { cwd, encoding: "utf8" });
  if (run.status === 0) return false;
  if (run.status === 1) return true;
  throw new Error(`git diff ${from} ${to} failed: ${run.stderr.trim()}`);
}

/** A file's text at a ref, or null when the ref does not carry it. */
function readAt(cwd, ref, path) {
  return git(cwd, ["show", `${ref}:${path}`], { allowFail: true });
}

/** The published npm packages, read from the one place that declares them. */
export function publishedPackages(workflowText) {
  const line = /PUBLISHED_PACKAGES:\s*"([^"]+)"/.exec(workflowText);
  if (!line) throw new Error("release.yml declares no PUBLISHED_PACKAGES");
  return line[1].trim().split(/\s+/);
}

/** `.distignore` lines as pathspec excludes under the plugin directory. */
export function distignoreExcludes(text, root) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => `:(exclude)${root}/${line.replace(/^\//, "")}`);
}

const pluginVersion = (text) => /^\s*\*\s*Version:\s*(\S+)/m.exec(text ?? "")?.[1] ?? null;
const npmVersion = (text) => (text ? JSON.parse(text).version : null);
const pyprojectVersion = (text) => /^version\s*=\s*"([^"]+)"/m.exec(text ?? "")?.[1] ?? null;

/**
 * The units each series ships at `ref`. A unit names the paths a consumer receives, the
 * excludes that never ship, and how to read its version at any ref.
 */
export function seriesAt(cwd, ref) {
  const workflow = readAt(cwd, ref, ".github/workflows/release.yml") ?? "";
  const npm = publishedPackages(workflow).map((pkg) => ({
    name: `@naulon/${pkg}`,
    paths: [`packages/${pkg}`],
    // Test files are excluded from every package build, so a test-only change ships nothing.
    excludes: [`:(exclude)packages/${pkg}/**/*.test.ts`],
    versionFile: `packages/${pkg}/package.json`,
    readVersion: npmVersion,
  }));
  const plugin = {
    name: "WordPress plugin",
    paths: ["plugins/naulon"],
    // The release zip is built from .distignore, so the guard and the artifact agree on what ships.
    excludes: distignoreExcludes(readAt(cwd, ref, "plugins/naulon/.distignore"), "plugins/naulon"),
    versionFile: "plugins/naulon/naulon.php",
    readVersion: pluginVersion,
  };
  const python = {
    name: "naulon (PyPI)",
    paths: ["packages/python"],
    excludes: [":(exclude)packages/python/tests"],
    versionFile: "packages/python/pyproject.toml",
    readVersion: pyprojectVersion,
  };
  return [
    { id: "npm", prefix: "v", units: [...npm, plugin] },
    { id: "python", prefix: "python-v", units: [python] },
  ];
}

export function seriesForTag(tag) {
  if (tag.startsWith("python-v")) return "python";
  if (/^v\d/.test(tag)) return "npm";
  throw new Error(`${tag} belongs to no release series (expected v<semver> or python-v<semver>)`);
}

/** The newest tag of one series reachable from `ref`, `ref` itself included. */
export function latestTag(cwd, prefix, ref) {
  return git(cwd, ["describe", "--tags", "--abbrev=0", "--match", `${prefix}[0-9]*`, ref], { allowFail: true });
}

/** Each unit's state between a series' previous tag and `ref`. */
export function drift(cwd, series, prev, ref) {
  return series.units.map((unit) => {
    const now = unit.readVersion(readAt(cwd, ref, unit.versionFile));
    if (!prev) return { unit: unit.name, state: "first", now };
    const was = unit.readVersion(readAt(cwd, prev, unit.versionFile));
    if (was === null) return { unit: unit.name, state: "new", now };
    if (!differs(cwd, prev, ref, [...unit.paths, ...unit.excludes])) return { unit: unit.name, state: "unchanged", was, now };
    return { unit: unit.name, state: was === now ? "stale" : "moved", was, now };
  });
}

/** Units that changed since their series' last tag: releases that are owed. */
export function status(cwd, ref = "HEAD") {
  return seriesAt(cwd, ref).map((series) => {
    const prev = latestTag(cwd, series.prefix, ref);
    const behind = drift(cwd, series, prev, ref).filter((d) => d.state === "stale" || d.state === "moved");
    return { series: series.id, prev, behind };
  });
}

/** Problems that must stop `tag` before it publishes. Empty means the tag may ship. */
export function check(cwd, tag) {
  const id = seriesForTag(tag);
  const series = seriesAt(cwd, tag).find((s) => s.id === id);
  const prev = latestTag(cwd, series.prefix, `${tag}^`);
  const problems = [];
  for (const d of drift(cwd, series, prev, tag)) {
    if (d.now === null) {
      problems.push(`${d.unit} has no readable version at ${tag}.`);
    } else if (d.state === "stale") {
      problems.push(`${d.unit} changed since ${prev} but its version is still ${d.now}. Bump it, or the registry skips it as already published.`);
    }
  }
  if (id === "python") {
    const want = tag.slice("python-v".length);
    const have = pyprojectVersion(readAt(cwd, tag, "packages/python/pyproject.toml"));
    const init = /__version__ = "([^"]+)"/.exec(readAt(cwd, tag, "packages/python/src/naulon/__init__.py") ?? "")?.[1] ?? null;
    if (want !== have || want !== init) {
      problems.push(`${tag} does not match pyproject.toml (${have}) and naulon.__version__ (${init}).`);
    }
  }
  const changelog = readAt(cwd, tag, "CHANGELOG.md") ?? "";
  const heading = new RegExp(`^## +${tag.replace(/\./g, "\\.")}(\\s|$)`, "m");
  if (!heading.test(changelog)) {
    problems.push(`CHANGELOG.md has no '## ${tag}' section. A release that ships nothing to a registry still needs one saying so.`);
  }
  return { series: id, prev, problems };
}

function main(argv) {
  const cwd = process.cwd();
  const [command, arg] = argv;
  const github = argv.includes("--github");

  if (command === "status") {
    for (const { series, prev, behind } of status(cwd)) {
      if (!prev) {
        console.log(`${series}: no tag yet`);
      } else if (behind.length === 0) {
        console.log(`${series}: current with ${prev}`);
      } else {
        const list = behind.map((d) => `${d.unit} ${d.was}${d.state === "moved" ? ` → ${d.now}` : " (not bumped)"}`).join(", ");
        const line = `${series} has changes since ${prev} that no registry serves: ${list}`;
        console.log(github ? `::warning title=${series} is behind ${prev}::${line}` : line);
      }
    }
    return 0;
  }

  if (command === "check" && arg) {
    const { series, prev, problems } = check(cwd, arg);
    console.log(`${arg}: ${series} series, previous tag ${prev ?? "none"}`);
    for (const problem of problems) console.log(github ? `::error::${problem}` : `error: ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }

  console.error("usage: release.mjs status [--github] | check <tag> [--github]");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
