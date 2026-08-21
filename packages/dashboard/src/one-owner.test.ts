/**
 * Things `public/` shares have exactly one owner — the tripwires for the two that didn't.
 *
 * `public/` is served raw to the browser: no build step, no bundler, no framework default
 * to lean on. Nothing here stops a page from copying a rule or a control instead of
 * importing it, and both had already happened by the time anyone measured.
 *
 * Both rules exist because of the same defect, found by measuring the rail rather than
 * reading it. Three rules style a `<button>` to read as text — the remove ✕, the theme
 * control, the webhook row actions — and each spelled the UA reset itself. A `<button>`
 * does not inherit the page's font, so each of them reached for `font: inherit`, which
 * *also* resets font-size to the parent's: the theme control shipped at 16px/24px beside
 * siblings at 12px/18px, and `.wh-link` only escaped it by restating 11.5px on the next
 * declaration.
 *
 * `app.css` is served raw to the browser and imports nothing, so there is no build step to
 * catch this and no framework default to lean on. A string check on the sheet is the whole
 * available mechanism — which is also why it is worth having.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const read = (f: string) => readFile(new URL(`./public/${f}`, import.meta.url), "utf8");
const css = await read("app.css");

/** Declarations only — `font-family:`/`font-size:` are fine, and comments may discuss it. */
const declarations = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/[;{}]/)
  .map((d) => d.trim());

test("app.css never uses the `font:` shorthand", () => {
  const offenders = declarations.filter((d) => /^font:\s/.test(d));
  assert.deepEqual(
    offenders,
    [],
    "`font:` resets font-size to the parent's, silently overriding the element's own class. " +
      "Set font-family / line-height by name and leave the size to the rule that owns it.",
  );
});

test("the bare-button reset has exactly one owner", () => {
  const owner = /\.x,\s*\.theme-btn,\s*\.wh-link\s*\{/;
  assert.match(
    css,
    owner,
    "The three button-as-text rules share one reset. Adding a fourth means joining that " +
      "selector, not copying the reset into a new rule.",
  );
  // Each may restate what differs (size, padding, colour) — none may re-fork the chrome.
  for (const cls of [".theme-btn", ".wh-link"]) {
    const body = css.match(new RegExp(`\\n\\${cls} \\{([^}]*)\\}`))?.[1];
    assert.ok(body, `${cls} rule not found`);
    assert.doesNotMatch(
      body,
      /background:|border:/,
      `${cls} re-declares chrome the shared reset already owns`,
    );
  }
});

/**
 * `testToll` shipped as two copies — Overview and Doctor — identical in behaviour and
 * already drifted in shape. It is a money-write control: it asks the gate to bill itself.
 * A probe that reports the same failure differently depending on which page you ran it
 * from teaches a reader two things about one gate, so it now lives in `shell.js` and both
 * pages mount it.
 */
test("the test-toll control is fetched from exactly one place", async () => {
  const pages = ["overview.js", "doctor.js", "ledger.js", "agents.js", "requests.js",
                 "content.js", "crawlers.js", "webhooks.js"];
  const copies: string[] = [];
  for (const page of pages) {
    if ((await read(page)).includes("/api/test-toll")) copies.push(page);
  }
  assert.deepEqual(
    copies,
    [],
    "A page calls /api/test-toll directly. Mount shell.js's wireTestToll() instead — the " +
      "control, its wording and its disabled state have one owner.",
  );
  assert.ok(
    (await read("shell.js")).includes("/api/test-toll"),
    "shell.js no longer owns the test-toll control",
  );
});
