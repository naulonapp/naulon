/**
 * The `font:` shorthand is banned in `app.css`, and the bare-button reset has one owner.
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

const css = await readFile(new URL("./public/app.css", import.meta.url), "utf8");

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
