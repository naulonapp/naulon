/**
 * `public/` is served raw to the browser and cannot import from `src/`, so the mark's
 * numbers exist twice: pinned in brand.ts, mirrored as literals in public/shell.js.
 * That is acceptable only if a divergence is loud. This is the tripwire.
 *
 * When it fails, fix shell.js — never brand.ts. brand.ts is the pinned copy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { MARK } from "./brand.ts";

const shell = await readFile(new URL("./public/shell.js", import.meta.url), "utf8");

test("shell.js carries the same mark geometry as brand.ts", () => {
  assert.ok(
    shell.includes(`"${MARK.arch}"`),
    "shell.js MARK_ARCH drifted from brand.ts MARK.arch",
  );
  assert.ok(
    shell.includes(`const MARK_STROKE = ${MARK.strokeWidth};`),
    "shell.js MARK_STROKE drifted from brand.ts MARK.strokeWidth",
  );
  assert.ok(
    shell.includes(`{ cx: ${MARK.coin.cx}, cy: ${MARK.coin.cy}, r: ${MARK.coin.r} }`),
    "shell.js MARK_COIN drifted from brand.ts MARK.coin",
  );
});

test("shell.js never hardcodes the brand green — the tile is a CSS token", () => {
  assert.ok(!/#2bf5a0/i.test(shell), "the green belongs in app.css, not in shell.js");
});
