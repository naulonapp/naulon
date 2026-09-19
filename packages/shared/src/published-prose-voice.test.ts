import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// @ts-expect-error - a plain .mjs checker, also used by .githooks/commit-msg and pre-commit.
import { checkProse } from "../../../scripts/prose-voice.mjs";

/**
 * Everything this repo publishes is read by someone deciding whether to adopt it, and by then
 * it is the only thing they have seen. The README is the project's front page, docs/ is the
 * documentation site, and each packages/*\/README.md is rendered as the entire npm package page.
 *
 * So the docs follow one house style, and the one rule of it a test can check without false
 * positives is the em dash: this project does not use them in prose. Code, indented blocks,
 * inline spans and URLs are excluded, so only prose is read.
 *
 * This is a sibling of no-private-names.test.ts and exists for the same reason: that rule had
 * been written down and was broken four times anyway. A rule nothing checks is a comment. When
 * this test was added the published corpus carried 515 violations across these files, against a
 * convention that had been in CONTRIBUTING.md the whole time.
 *
 * Deliberately NOT checked here: tone, rhythm, hedging, or a paragraph that explains when it
 * should ask. Those stay a review judgment, and a test that claimed them would be trusted for
 * something it cannot do.
 *
 * Source comments are also out of scope, on purpose. A comment is read by someone already inside
 * the code, and the repo's long explanatory comments are an asset: rewriting thousands of them
 * for punctuation would risk their meaning to no reader's benefit. What a comment must not carry
 * is a private name, which no-private-names.test.ts already refuses.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** Every file a reader outside this project can end up looking at. */
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "DEPLOY.md", "CHANGELOG.md", "SECURITY.md"];

/** A PR template is read before the code is. Issue forms are YAML and are shape-checked elsewhere. */
const TEMPLATES = [join("\u002egithub", "PULL_REQUEST_TEMPLATE.md")];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "vendor"]);
const MARKDOWN = /\.(md|mdx)$/;

function* walk(dir: string, match: RegExp): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, match);
    else if (match.test(entry)) yield full;
  }
}

function packageReadmes(): string[] {
  const packages = join(REPO, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages)
    .map((name) => join(packages, name, "README.md"))
    .filter(existsSync);
}

function published(): string[] {
  return [
    ...ROOT_DOCS.map((name) => join(REPO, name)),
    ...walk(join(REPO, "docs"), MARKDOWN),
    ...packageReadmes(),
    ...TEMPLATES.map((t) => join(REPO, t)),
    join(REPO, "plugins", "naulon", "readme.txt"),
  ].filter(existsSync);
}

test("published prose follows the house style", () => {
  const files = published();

  // A test that silently passes because it found nothing is the failure mode here, so the
  // inputs are asserted before the contents are.
  assert.ok(files.length > 15, `expected the published docs to be found, saw ${files.length}`);
  assert.ok(
    files.some((f) => f.endsWith(join("packages", "shared", "README.md"))),
    "expected the package READMEs to be included",
  );

  const offences: string[] = [];
  for (const file of files) {
    for (const v of checkProse(readFileSync(file, "utf8")) as {
      line: number;
      column: number;
      detail: string;
    }[]) {
      offences.push(`${relative(REPO, file)}:${v.line}:${v.column}\n    ${v.detail}`);
    }
  }

  assert.equal(
    offences.length,
    0,
    `${offences.length} published line(s) carry an em dash:\n\n${offences.join("\n")}\n\n` +
      `Use a full stop, a comma or a colon. The clause after an em dash is usually an appositive\n` +
      `restating the clause before it, so deleting it is nearly always the right fix.\n` +
      `The style guide is in CONTRIBUTING.md.`,
  );
});
