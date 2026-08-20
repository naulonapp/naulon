import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The sidebar's gate pill has ONE owner, and this is what keeps it that way.
 *
 * It used to have eight. `setGate(up, label)` was exported, every page called it with a
 * label of its own, and three of them had no gate fact to report — so they painted the
 * pill from what they DID know. Measured with the gate unreachable, in one pass:
 *
 *     /          gate down — unreachable   red
 *     /requests  recording traffic         GREEN   ← its own fetch succeeding
 *     /agents    recording traffic         GREEN   ← same
 *     /ledger    settling live             GREEN   ← its SSE socket being open
 *     /content   gate down                 red
 *     /crawlers  gate down                 red
 *     /webhooks  gate unreachable          red
 *     /doctor    gate down                 red
 *
 * "settling live" beside a dead gate is not a gentler truth, it is the opposite of one,
 * and the five honest pages still spelled one state three ways. `shell.js` now polls
 * `/api/gate` and owns both the fact and the words; `setGate` is module-private.
 *
 * A text read, like `verdict-parity.test.ts` — `public/*.js` is browser code and importing
 * it here would make this test hostage to the DOM globals it touches at module scope.
 */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const pageScripts = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js") && f !== "shell.js");

test("every console page ships a script this test can see", () => {
  // A rename that emptied the list would make every assertion below vacuously pass.
  assert.ok(pageScripts.length >= 8, `expected the console's page scripts, found ${pageScripts.length}`);
});

test("shell.js keeps setGate private — no page can paint the rail", () => {
  const shell = readFileSync(join(PUBLIC_DIR, "shell.js"), "utf8");
  assert.ok(
    !/export\s+(function\s+setGate|const\s+setGate)/.test(shell),
    "setGate is exported again — that is how the rail got eight owners and three false greens",
  );
  assert.ok(shell.includes('fetch("/api/gate"'), "the rail no longer reads /api/gate, so nothing owns the gate fact");
});

test("no page imports or calls setGate", () => {
  for (const f of pageScripts) {
    const src = readFileSync(join(PUBLIC_DIR, f), "utf8");
    assert.ok(!/\bsetGate\b/.test(src), `${f} references setGate — the rail is shell.js's alone`);
  }
});

/** Drop comments before scanning for vocabulary: a doc comment that NAMES the old strings
 *  to explain the incident is exactly what we want written down, and must not fail here. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no page invents its own gate vocabulary", () => {
  // The exact strings the three lying pages used, plus the spellings the honest ones
  // disagreed on. Any of them reappearing in page CODE means the class is back.
  const BANNED = ["settling live", "recording traffic", "dashboard offline", "gate unreachable", "gate up", "gate down"];
  for (const f of pageScripts) {
    const src = stripComments(readFileSync(join(PUBLIC_DIR, f), "utf8"));
    for (const phrase of BANNED) {
      assert.ok(
        !src.includes(phrase),
        `${f} spells the gate state itself ("${phrase}") — shell.js owns that vocabulary`,
      );
    }
  }
});
