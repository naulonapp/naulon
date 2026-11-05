import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { check, gitEnv, seriesForTag, status } from "./release.mjs";

// Each test builds a small repository with the same layout as this one: one published npm
// package, the plugin and the Python package, tagged in both series.
//
// Every git call here runs with gitEnv(). This suite runs inside the pre-push hook, where git
// exports GIT_DIR for the repository being pushed; without the scrub, `git init`, `commit` and
// `tag` below would write into that repository instead of the throwaway one.

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "naulon-release-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env: gitEnv(), encoding: "utf8" }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);
  };
  const tag = (name) => git("tag", name);

  git("init", "-q", "-b", "main");
  write(".github/workflows/release.yml", 'env:\n  PUBLISHED_PACKAGES: "shared"\n');
  write("packages/shared/package.json", JSON.stringify({ name: "@naulon/shared", version: "0.1.0" }));
  write("packages/shared/src/index.ts", "export const a = 1;\n");
  write("plugins/naulon/naulon.php", "<?php\n/**\n * Version:           0.1.0\n */\n");
  write("plugins/naulon/.distignore", "# dev only\n/tests\n/bin\n");
  write("packages/python/pyproject.toml", '[project]\nname = "naulon"\nversion = "0.1.0"\n');
  write("packages/python/src/naulon/__init__.py", '__version__ = "0.1.0"\n');
  write("CHANGELOG.md", "# Changelog\n\n## v0.1.0\n\n## python-v0.1.0\n");
  commit("initial");
  tag("v0.1.0");
  tag("python-v0.1.0");

  const setVersion = {
    shared: (v) => write("packages/shared/package.json", JSON.stringify({ name: "@naulon/shared", version: v })),
    plugin: (v) => write("plugins/naulon/naulon.php", `<?php\n/**\n * Version:           ${v}\n */\n`),
    python: (v, init = v) => {
      write("packages/python/pyproject.toml", `[project]\nname = "naulon"\nversion = "${v}"\n`);
      write("packages/python/src/naulon/__init__.py", `__version__ = "${init}"\n`);
    },
  };
  const changelog = (...tags) => write("CHANGELOG.md", `# Changelog\n\n${tags.map((t) => `## ${t}\n`).join("\n")}`);
  return { dir, write, commit, tag, setVersion, changelog };
}

test("a python tag on a later commit never becomes the npm baseline", () => {
  const r = repo();
  r.write("packages/shared/src/index.ts", "export const a = 2;\n");
  r.commit("change shared after v0.1.0");
  r.write("packages/python/src/naulon/extra.py", "x = 1\n");
  r.setVersion.python("0.2.0");
  r.changelog("v0.1.0", "python-v0.1.0", "python-v0.2.0", "v0.2.0");
  r.commit("python release");
  r.tag("python-v0.2.0");
  r.commit("npm release that forgot to bump shared");
  r.tag("v0.2.0");

  // `git describe --tags` alone would return python-v0.2.0 here, and shared did not change
  // after it, so the forgotten bump would pass.
  const result = check(r.dir, "v0.2.0");
  assert.equal(result.prev, "v0.1.0");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /@naulon\/shared changed since v0\.1\.0 but its version is still 0\.1\.0/);
});

test("a changed npm package passes once its version moves", () => {
  const r = repo();
  r.write("packages/shared/src/index.ts", "export const a = 2;\n");
  r.setVersion.shared("0.1.1");
  r.changelog("v0.1.0", "v0.1.1");
  r.commit("release");
  r.tag("v0.1.1");
  assert.deepEqual(check(r.dir, "v0.1.1").problems, []);
});

test("a test-only package change and a .distignore-only plugin change need no bump", () => {
  const r = repo();
  r.write("packages/shared/src/index.test.ts", "// test\n");
  r.write("plugins/naulon/tests/unit/AThing.php", "<?php\n");
  r.write("plugins/naulon/bin/tool.sh", "#!/bin/sh\n");
  r.changelog("v0.1.0", "v0.1.1");
  r.commit("tests and tooling only");
  r.tag("v0.1.1");
  assert.deepEqual(check(r.dir, "v0.1.1").problems, []);
});

test("a shipped plugin change without a version bump is refused", () => {
  const r = repo();
  r.write("plugins/naulon/includes/class-a.php", "<?php\n");
  r.changelog("v0.1.0", "v0.1.1");
  r.commit("plugin change");
  r.tag("v0.1.1");
  const problems = check(r.dir, "v0.1.1").problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /WordPress plugin changed since v0\.1\.0/);
});

test("a unit whose version cannot be read is refused, never read as moved", () => {
  const r = repo();
  r.write("plugins/naulon/naulon.php", "<?php\n// header lost\n");
  r.changelog("v0.1.0", "v0.1.1");
  r.commit("plugin header lost");
  r.tag("v0.1.1");
  const problems = check(r.dir, "v0.1.1").problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /WordPress plugin has no readable version at v0\.1\.1/);
});

test("a python tag must match pyproject.toml and __version__, and the package must have moved", () => {
  const r = repo();
  r.write("packages/python/src/naulon/extra.py", "x = 1\n");
  r.setVersion.python("0.2.0", "0.1.0");
  r.changelog("v0.1.0", "python-v0.1.0", "python-v0.2.0");
  r.commit("half-bumped python");
  r.tag("python-v0.2.0");
  const problems = check(r.dir, "python-v0.2.0").problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not match pyproject\.toml \(0\.2\.0\) and naulon\.__version__ \(0\.1\.0\)/);

  const ok = repo();
  ok.write("packages/python/src/naulon/extra.py", "x = 1\n");
  ok.setVersion.python("0.2.0");
  ok.changelog("v0.1.0", "python-v0.1.0", "python-v0.2.0");
  ok.commit("python release");
  ok.tag("python-v0.2.0");
  const result = check(ok.dir, "python-v0.2.0");
  assert.equal(result.prev, "python-v0.1.0");
  assert.deepEqual(result.problems, []);
});

test("a tag without its CHANGELOG section is refused, and the version dots match literally", () => {
  const r = repo();
  r.changelog("v0.1.0", "v0x1x1");
  r.commit("nothing shipped");
  r.tag("v0.1.1");
  const problems = check(r.dir, "v0.1.1").problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], /CHANGELOG\.md has no '## v0\.1\.1' section/);
});

test("status names the series that owe a release and stays quiet for the current one", () => {
  const r = repo();
  r.write("packages/python/src/naulon/extra.py", "x = 1\n");
  r.commit("python change, no release");
  const bySeries = Object.fromEntries(status(r.dir).map((s) => [s.series, s]));
  assert.deepEqual(bySeries.npm.behind, []);
  assert.equal(bySeries.python.prev, "python-v0.1.0");
  assert.deepEqual(bySeries.python.behind.map((d) => [d.unit, d.state]), [["naulon (PyPI)", "stale"]]);
});

test("a GIT_DIR exported by a hook cannot point the guard at another repository", () => {
  const pushed = repo();
  pushed.write("packages/shared/src/index.ts", "export const a = 2;\n");
  pushed.changelog("v0.1.0", "v0.1.1");
  pushed.commit("forgot to bump shared");
  pushed.tag("v0.1.1");

  const other = repo();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.dir, ".git");
  try {
    // Read through `other`, v0.1.1 does not exist and the shared change is invisible.
    const problems = check(pushed.dir, "v0.1.1").problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /@naulon\/shared changed since v0\.1\.0/);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
  assert.equal(gitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_INDEX_FILE: "/z", PATH: "/bin" }).PATH, "/bin");
  assert.deepEqual(Object.keys(gitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_INDEX_FILE: "/z" })), []);
});

test("a tag outside both series is refused rather than guessed", () => {
  assert.equal(seriesForTag("v1.2.3"), "npm");
  assert.equal(seriesForTag("python-v1.2.3"), "python");
  assert.throws(() => seriesForTag("plugin-1.0"), /belongs to no release series/);
  assert.throws(() => seriesForTag("vnext"), /belongs to no release series/);
});
