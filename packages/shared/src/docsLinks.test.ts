import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation reachability + naming parity.
 *
 * `configDocs.test.ts` tripwires the env reference to the schema. This one covers the two
 * ways a doc rots that a config check cannot see.
 *
 * 1. **An orphan page.** `docs/crawl-adapters.md` shipped in v0.6.0 and was linked from
 *    nothing but the changelog entry that announced it — `docs/README.md` is the index a
 *    reader actually starts from, and the page was not in it. A doc nobody can navigate to
 *    is a doc nobody reads.
 * 2. **A dead relative link.** A page renamed or moved leaves every link to it pointing at
 *    nothing, and markdown fails silently.
 *
 * It also extends the "names no variable nothing reads" check BEYOND `configuration.md`'s
 * table rows to backticked env names in the prose of every doc — which is where
 * `LICENSES_ONLINE_CHECK` (the real key is `LICENSE_ONLINE_CHECK`) sat in
 * `citation-license.md`, telling a self-hoster to set a var no code reads, so their
 * revocation check silently stayed off.
 */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DOCS = `${REPO}docs/`;

function docFiles(): string[] {
  return readdirSync(DOCS).filter((f) => f.endsWith(".md") && f !== "README.md");
}

/** Relative markdown links, minus anchors and external schemes. */
function relativeLinks(body: string): string[] {
  return [...body.matchAll(/\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)]
    .map((m) => m[1]!.split("#")[0]!)
    .filter(Boolean);
}

test("every docs/ page is reachable from the docs index", () => {
  const index = readFileSync(`${DOCS}README.md`, "utf8");
  const orphans = docFiles().filter((f) => !index.includes(f));
  assert.deepEqual(
    orphans,
    [],
    `these docs exist but docs/README.md links to none of them, so a reader never finds them: ${orphans.join(", ")}`,
  );
});

test("every relative link in the docs and the root pages resolves", () => {
  const pages = [
    ...docFiles().map((f) => `${DOCS}${f}`),
    `${DOCS}README.md`,
    `${REPO}README.md`,
    `${REPO}CONTRIBUTING.md`,
    `${REPO}DEPLOY.md`,
  ];
  const dead: string[] = [];
  for (const page of pages) {
    const body = readFileSync(page, "utf8");
    for (const target of relativeLinks(body)) {
      if (!existsSync(resolve(dirname(page), target))) {
        dead.push(`${page.slice(REPO.length)} → ${target}`);
      }
    }
  }
  assert.deepEqual(dead, [], `dead relative links:\n  ${dead.join("\n  ")}`);
});

/** Every `SCREAMING_CASE` name a doc puts in backticks, excluding prose-y false friends. */
const NOT_ENV = new Set([
  "README", "LICENSE", "CHANGELOG", "DEPLOY", "CONTRIBUTING",
  "HTTP", "HTTPS", "JSON", "JSONL", "HTML", "USDC", "JWKS", "HMAC", "MUST", "NOTE",
  "GET", "POST", "PUT", "PATCH", "DELETE",
]);

function backtickedEnvNames(body: string): string[] {
  return [...body.matchAll(/`([A-Z][A-Z_0-9]{3,})`/g)].map((m) => m[1]!).filter((k) => !NOT_ENV.has(k));
}

/**
 * A doc may deliberately name a DELETED variable — telling a self-hoster their old `.env`
 * key is now inert is exactly the sentence that stops them debugging a setting that does
 * nothing. That is declared per file, not guessed from the prose around it:
 *
 *   <!-- naulon-docs: deleted-names CREDITS_SETTLEMENT_SECRET, SETTLEMENT_OUTBOX_PATH -->
 *
 * An explicit list means removing the tombstone re-arms the check, and a typo inside the
 * tombstone still fails (it is not in the code either).
 */
function tombstonedNames(body: string): Set<string> {
  const m = body.match(/<!--\s*naulon-docs:\s*deleted-names\s+([^>]*?)-->/);
  if (!m) return new Set();
  return new Set(m[1]!.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

function knownNames(): Set<string> {
  const out = new Set<string>();
  const src = readFileSync(`${REPO}packages/shared/src/config.ts`, "utf8");
  for (const m of src.matchAll(/^ {2}([A-Z][A-Z_0-9]+):/gm)) out.add(m[1]!);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (e.name.endsWith(".ts")) {
        const body = readFileSync(p, "utf8");
        // read from env, or exported as a constant/type a doc may legitimately name
        for (const m of body.matchAll(/env(?:\.|\["|\['")([A-Z][A-Z_0-9]{3,})/g)) out.add(m[1]!);
        for (const m of body.matchAll(/\b(?:const|let|type|enum)\s+([A-Z][A-Z_0-9]{3,})\b/g)) out.add(m[1]!);
      }
    }
  };
  walk(`${REPO}packages`);
  return out;
}

test("no doc names an env var or constant nothing in the code defines", () => {
  const known = knownNames();
  const unknown: string[] = [];
  for (const f of docFiles()) {
    const body = readFileSync(`${DOCS}${f}`, "utf8");
    const tombstoned = tombstonedNames(body);
    for (const name of backtickedEnvNames(body)) {
      if (!known.has(name) && !tombstoned.has(name)) unknown.push(`docs/${f} → ${name}`);
    }
  }
  assert.deepEqual(
    unknown,
    [],
    `docs name identifiers no code defines (a typo here is a setting that silently does nothing):\n  ${unknown.join("\n  ")}`,
  );
});
