/**
 * No unbounded PostgREST set-read anywhere in the packages.
 *
 * PostgREST clips a select at its own `db-max-rows` and answers 200 — no error, no header a caller
 * checks. A clipped read is therefore indistinguishable from a complete one: it typechecks, it
 * passes unit tests against a fake with no cap, and it is wrong only against a table that grew.
 *
 * `readAllPaged` fixes the reads we know about. This refuses the next one, because the class has
 * already recurred: it was fixed here in `supabaseSink.readAll`, then reintroduced in the private
 * control plane's catalog reads months later. A rule with nothing executing it is not a rule.
 *
 * The scan over-reports by design — a read filtered to a primary key returns one row and cannot
 * truncate — so each hit is triaged once into ALLOW with the reason it is safe. That review is the
 * point: the question gets asked in a pull request instead of in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** `packages/` — every published package, not just this one. */
const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

/** Lines either side of a `select=` that still count as the same request statement. */
const WINDOW = 4;

/** Tokens that bound a read, or prove it is not a set read. */
const BOUNDED = ["limit=", "readAllPaged", "Range", "count=exact"];

/**
 * Reviewed exceptions: `package/relative/path.ts` → why truncation cannot bite.
 *
 * Keep this small. An entry is a claim that the result set has a ceiling other than the row cap,
 * and it has to name it.
 */
const ALLOW = new Map<string, string>([
  ["shared/src/supabase.ts", "the docblock example URL, not a live query"],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Every `select=` in a REST path that carries no bound, keyed as ALLOW keys them. */
function unboundedReads(): string[] {
  const found: string[] = [];
  for (const file of walk(PACKAGES)) {
    const rel = relative(PACKAGES, file);
    if (ALLOW.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("select=")) return;
      // A request path is routinely built across several lines, so the bound can sit on a
      // neighbouring one — judge the statement, not the line.
      const stmt = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
      if (BOUNDED.some((k) => stmt.includes(k))) return;
      found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

test("every PostgREST set read is bounded, or is a reviewed exception", () => {
  assert.deepEqual(
    unboundedReads(),
    [],
    "Unbounded PostgREST select(s). PostgREST clips at db-max-rows and returns 200, so this is " +
      "silent past the cap. Page it with `readAllPaged`, bound it with an explicit `limit=`, or " +
      "add it to ALLOW with the reason it cannot truncate.",
  );
});

test("the allowlist has no dead entries", () => {
  // An exception for a read that was since fixed or moved is a stale claim about code that no
  // longer exists — the same rot the truncation bug itself was made of.
  const files = new Set(walk(PACKAGES).map((f) => relative(PACKAGES, f)));
  const dead = [...ALLOW.keys()].filter((k) => !files.has(k));
  assert.deepEqual(dead, [], `ALLOW names files that no longer exist: ${dead.join(", ")}`);
});
