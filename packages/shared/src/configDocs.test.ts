import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Config documentation parity.
 *
 * `config.ts` carries a careful comment for every variable — and none of that reached a
 * reader who wasn't reading the source. Nothing in `docs/`, the README or `DEPLOY.md`
 * named `RATE_LIMIT_MAX_BUCKETS`, the `BOT_AUTH_*` identity keys, or any of the
 * settlement retry knobs, and `.env.example` had silently fallen six keys behind the
 * schema — including `ARC_RPC_URL` and `RELAYER_PRIVATE_KEY_MAINNET`, both of which a
 * mainnet settle fails without.
 *
 * A reference page copied by hand rots, so it is tripwired to the schema instead:
 * every key must appear in `docs/configuration.md` AND in `.env.example`, and neither
 * may name a key the schema doesn't define. Adding a variable without documenting it
 * fails here.
 *
 * The schema is read as SOURCE rather than imported: `configSchema` is wrapped in
 * `.superRefine()`, so its shape is only reachable through zod internals that a version
 * bump is free to move. The declaration order in the file is also what the doc's section
 * order follows, which the internals wouldn't give us.
 */
const CONFIG = fileURLToPath(new URL("./config.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function schemaKeys(): string[] {
  const src = readFileSync(CONFIG, "utf8");
  const body = src.slice(src.indexOf("export const configSchema"));
  const keys = [...body.matchAll(/^ {2}([A-Z][A-Z_0-9]+):/gm)].map((m) => m[1]!);
  assert.ok(keys.length > 50, `only found ${keys.length} keys in config.ts — the parser is broken, not the docs`);
  return keys;
}

function envExampleKeys(): string[] {
  const src = readFileSync(`${REPO}.env.example`, "utf8");
  return [...src.matchAll(/^#?\s*([A-Z][A-Z_0-9]+)=/gm)].map((m) => m[1]!);
}

test("every config key is documented in docs/configuration.md", () => {
  const doc = readFileSync(`${REPO}docs/configuration.md`, "utf8");
  const undocumented = schemaKeys().filter((k) => !doc.includes(k));
  assert.deepEqual(
    undocumented,
    [],
    `these env vars exist in config.ts but appear nowhere in docs/configuration.md: ${undocumented.join(", ")}`,
  );
});

test("every config key appears in .env.example", () => {
  const example = new Set(envExampleKeys());
  const missing = schemaKeys().filter((k) => !example.has(k));
  assert.deepEqual(
    missing,
    [],
    `these env vars exist in config.ts but not in .env.example: ${missing.join(", ")}`,
  );
});

/**
 * The direction the other three tests never covered: a row on the reference page for a
 * variable NOTHING reads. `SUPABASE_SETTLEMENT_DELIVERY_TABLE` sat there documented as a
 * "table override" after the wire that read it was deleted — an operator could set it and
 * change nothing. A documented key must be in the schema, or read straight from
 * `process.env` somewhere in `packages/` (the MCP server's `NAULON_CLOUD_*` trio takes an
 * injected env record rather than the gate's validated config).
 */
function documentedKeys(doc: string): string[] {
  return [...doc.matchAll(/\|\s*`([A-Z][A-Z_0-9]{3,})`\s*\|/g)].map((m) => m[1]!);
}

function readDirectlyFromEnv(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (e.name.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/env(?:\.|\["|\['")([A-Z][A-Z_0-9]{3,})/g)) out.add(m[1]!);
      }
    }
  };
  walk(`${REPO}packages`);
  return out;
}

test("docs/configuration.md names no variable nothing reads", () => {
  const doc = readFileSync(`${REPO}docs/configuration.md`, "utf8");
  const schema = new Set(schemaKeys());
  const direct = readDirectlyFromEnv();
  const dead = documentedKeys(doc).filter((k) => !schema.has(k) && !direct.has(k));
  assert.deepEqual(
    dead,
    [],
    `docs/configuration.md documents env vars no code reads: ${dead.join(", ")}`,
  );
});

test(".env.example names no key the schema does not define", () => {
  const schema = new Set(schemaKeys());
  const stale = envExampleKeys().filter((k) => !schema.has(k));
  assert.deepEqual(
    stale,
    [],
    `.env.example names env vars config.ts does not read: ${stale.join(", ")}`,
  );
});
