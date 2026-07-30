import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test(".env.example names no key the schema does not define", () => {
  const schema = new Set(schemaKeys());
  const stale = envExampleKeys().filter((k) => !schema.has(k));
  assert.deepEqual(
    stale,
    [],
    `.env.example names env vars config.ts does not read: ${stale.join(", ")}`,
  );
});
