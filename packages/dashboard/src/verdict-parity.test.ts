import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { OBSERVATION_VERDICTS } from "@naulon/shared";

import { VERDICTS } from "./traffic.ts";

/**
 * One vocabulary, three renderers, and only one of them can import it.
 *
 * `traffic.ts` and `ops.ts` now take `OBSERVATION_VERDICTS` from shared, so they cannot drift.
 * `public/shell.js` is served to the BROWSER — it cannot import from a workspace package, so it
 * holds the one copy that is still a copy. This test is what that copy costs.
 *
 * The drift it exists to catch already happened: `unservable` was added to `ObservationVerdict`
 * and to none of the three mirrors. Both aggregators skip an unknown verdict
 * (`if (o.verdict in byVerdict)`), so the verdict counted toward the window total and toward no
 * bar — the counters quietly stopped summing to the total, and `parseVerdict` refused to filter
 * for it. Nothing failed; the number was just wrong.
 *
 * It is deliberately a text read rather than an import: `shell.js` is browser code, and importing
 * it here would make this test hostage to whatever DOM globals it touches at module scope.
 */

const SHELL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "public", "shell.js"), "utf8");

/** Pull a flat array literal of string members out of the browser shell by export name. */
function shellArray(name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(SHELL);
  assert.ok(m, `shell.js no longer exports an array named ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** Pull the keys of a flat object literal, quoted or bare. */
function shellObjectKeys(name: string): string[] {
  const m = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(SHELL);
  assert.ok(m, `shell.js no longer exports an object named ${name}`);
  return [...m[1]!.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)].map((x) => x[1] ?? x[2]!);
}

/** Pull the members of a `new Set([...])` literal. */
function shellSet(name: string): string[] {
  const m = new RegExp(`export const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SHELL);
  assert.ok(m, `shell.js no longer exports a Set named ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

test("the console's verdict list is shared's, in the same order", () => {
  // Order is presentation order, and the counter strip renders in list order — so this is
  // equality, not set-equality.
  assert.deepEqual(shellArray("VERDICTS"), [...OBSERVATION_VERDICTS]);
});

test("every verdict has a counter-strip label", () => {
  // A verdict with no label renders `undefined` in the strip. Set-equality here: the object's key
  // order does not drive anything.
  assert.deepEqual(shellObjectKeys("VERDICT_LABEL").sort(), [...OBSERVATION_VERDICTS].sort());
});

test("VERDICT_BAD names only real verdicts", () => {
  // Which verdicts are "bad" is a judgement, so this asserts membership, not the whole set — a
  // typo'd entry would otherwise sit there colouring nothing.
  for (const v of shellSet("VERDICT_BAD")) {
    assert.ok(
      (OBSERVATION_VERDICTS as readonly string[]).includes(v),
      `VERDICT_BAD names ${JSON.stringify(v)}, which is not a verdict`,
    );
  }
});

test("the server-side list is shared's too", () => {
  assert.deepEqual([...VERDICTS], [...OBSERVATION_VERDICTS]);
});

test("unservable specifically is present everywhere it must be", () => {
  // The regression that motivated this file, pinned by name so a future refactor cannot quietly
  // drop it again.
  assert.ok(shellArray("VERDICTS").includes("unservable"));
  assert.ok(shellObjectKeys("VERDICT_LABEL").includes("unservable"));
  assert.ok(VERDICTS.includes("unservable"));
});
