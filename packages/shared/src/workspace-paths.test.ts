import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The root tsconfig maps each @naulon/* specifier to its source. `make dev` runs under that
// file, so an internal import it does not map resolves through node_modules to dist/, and on a
// tree with no build the dev stack cannot start. Tests never notice: `make test` builds dist
// first. This reads every import in the workspace and refuses one the mapping does not cover.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

function mappedSpecifiers(): Set<string> {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  const paths = (parsed.config as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths ?? {};
  return new Set(Object.keys(paths));
}

/** Every `@naulon/*` module a file imports, re-exports or loads dynamically. TypeScript's own
 *  scanner reads the tokens, so a specifier in a comment or a string literal is not an import. */
export function naulonImports(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((f) => f.fileName)
    .filter((name) => name.startsWith("@naulon/"));
}

test("every @naulon/* specifier the workspace imports is mapped to source in the root tsconfig", () => {
  const mapped = mappedSpecifiers();
  const missing = new Map<string, string>();
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    if (!statSync(join(ROOT, "packages", pkg)).isDirectory()) continue;
    let files: string[] = [];
    try {
      files = sources(src);
    } catch {
      continue;
    }
    for (const file of files) {
      for (const spec of naulonImports(readFileSync(file, "utf8"))) {
        if (!mapped.has(spec) && !missing.has(spec)) missing.set(spec, file.slice(ROOT.length));
      }
    }
  }
  assert.deepEqual(
    [...missing].map(([spec, file]) => `${spec} (first imported by ${file})`),
    [],
    "add these to compilerOptions.paths in the root tsconfig.json",
  );
});

test("the reader finds static, re-export and dynamic imports, and skips comments", () => {
  const source = [
    `import { a } from "@naulon/sdk/rsl";`,
    `export * from "@naulon/shared";`,
    `const m = await import("@naulon/enforce/next");`,
    `// re-exported as @naulon/sdk/enforce/next, which is not an import`,
    `const label = "@naulon/sdk/crawl/testing";`,
  ].join("\n");
  assert.deepEqual(naulonImports(source), ["@naulon/sdk/rsl", "@naulon/shared", "@naulon/enforce/next"]);
});
