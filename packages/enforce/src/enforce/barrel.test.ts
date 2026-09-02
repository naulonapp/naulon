/**
 * The package barrel reaches every in-app-enforcement module — the tripwire for the
 * omission that shipped.
 *
 * `observation-sink.ts` was written, built, and unit-tested, and was still unreachable:
 * `src/index.ts` re-exported three of the four `./enforce/*` modules, and the package
 * `exports` map publishes "." and "./next" only, so the sibling barrel `./enforce/index.ts`
 * that DID list it was not a path any consumer could take. The documented snippet
 * `import { httpObservationSink } from "@naulon/enforce"` therefore threw at module load.
 *
 * Every existing test in this directory imports its subject by relative path, which is
 * exactly why none of them saw it. This one asserts reachability instead of behaviour, so
 * it fails on the barrel rather than on the feature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as root from "../index.ts";
import * as configSource from "./config-source.ts";
import * as fetchHandler from "./fetch-handler.ts";
import * as middleware from "./middleware.ts";
import * as observationSink from "./observation-sink.ts";
import * as quoteSource from "./quote-source.ts";

/** Barrels, and the Next adapter — deliberately NOT in the core barrel, because it imports
 *  `next/server` and would pull the framework into every consumer of the kernel. */
const NOT_IN_CORE_BARREL = new Set(["index.ts", "next.ts"]);

const CORE = {
  "config-source.ts": configSource,
  "fetch-handler.ts": fetchHandler,
  "middleware.ts": middleware,
  "observation-sink.ts": observationSink,
  "quote-source.ts": quoteSource,
} as const;

for (const [file, mod] of Object.entries(CORE)) {
  test(`@naulon/enforce re-exports every value in enforce/${file}`, () => {
    const missing = Object.keys(mod).filter((name) => !(name in root));
    assert.deepEqual(
      missing,
      [],
      `enforce/${file} exports ${missing.join(", ")}, which no consumer of "@naulon/enforce" can import — add it to src/index.ts`,
    );
  });
}

test("no enforce/ module is left out of the reachability check", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const modules = readdirSync(join(here))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !NOT_IN_CORE_BARREL.has(f))
    .sort();
  // A new sibling module must be added to CORE above (and to the barrel), or it ships
  // unreachable exactly as observation-sink.ts did.
  assert.deepEqual(modules, Object.keys(CORE).sort());
});
