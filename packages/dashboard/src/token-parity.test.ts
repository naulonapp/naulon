/**
 * The console's palette, pinned.
 *
 * `app.css` is served raw to a browser and imports nothing, so its tokens are literals. The
 * values come from the published design system (https://naulon.app/brand) — the same one a
 * hosted control plane built on this core renders — and a drift between them is invisible:
 * every colour still resolves, the UI just stops being the same product.
 *
 * What this CAN check: that app.css still carries these exact values, that light and dark
 * define the SAME token set (a token defined in only one theme is a hole that appears when a
 * reader flips), and that no name repeats a name the design system uses for something else.
 *
 * What it CANNOT check: whether the design system itself moved. That lives in another repo
 * this one must not know about — the dependency points one way. So this is a tripwire on
 * *our* copy, not a sync, and when the palette is deliberately changed the fix is to edit
 * this table in the same commit.
 *
 * The other half of that pair lives on the private side and pins these tokens to the portal's
 * name-by-name. Renaming a token here without updating it there turns its suite red — which is
 * how the `--surface-2` → `--elev-2` rename was caught.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("./public/app.css", import.meta.url), "utf8");

/** The tokens as published. Elevation reads sidebar < bg < card < elev-2. */
const DARK: Record<string, string> = {
  "--sidebar": "#050609",
  "--sidebar-accent": "#0e1218",
  "--sidebar-muted": "#7c8593",
  "--bg": "#07080b",
  "--card": "#11141c",
  "--elev-2": "#1a1f29",
  "--fg": "#e9edf3",
  "--muted-fg": "#8d96a3",
  "--faint": "#828c9a",
  "--line": "#242b39",
  "--line-strong": "#2e3647",
  "--input": "#313a4b",
  "--primary": "#2bf5a0",
  "--primary-ink": "#04130c",
  "--down": "#ff476f",
  "--warning": "#ffb020",
  "--info": "#38bdf8",
};

/** Pull a `:root`-level (or themed) block's `--token: value;` pairs. */
function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name && value) out[name] = value.trim();
  }
  return out;
}

/** The `:root { … }` block — the dark defaults. */
function rootBlock(): string {
  const start = css.indexOf(":root {");
  assert.ok(start >= 0, "app.css has no :root block");
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

test("every published colour is still the published value", () => {
  const got = tokensIn(rootBlock());
  const wrong: string[] = [];
  for (const [name, value] of Object.entries(DARK)) {
    if (got[name] !== value) wrong.push(`${name}: expected ${value}, app.css has ${got[name] ?? "(missing)"}`);
  }
  assert.deepEqual(wrong, [], `the console palette drifted from the published one:\n${wrong.join("\n")}`);
});

test("elevation is four distinct steps, darkest first", () => {
  const got = tokensIn(rootBlock());
  const steps = ["--sidebar", "--bg", "--card", "--elev-2"].map((t) => got[t]);
  assert.equal(new Set(steps).size, 4, "two elevation steps are the same colour — the depth is gone");
});

/**
 * The rename this file was written for. The design system uses `--surface-2` for a DIFFERENT
 * grey (#1a2030) than the step this console needs (#1a1f29, its `--secondary`), so one name
 * meant two colours across the two codebases that share the palette. Reusing the name again
 * re-opens that: a rule ported between them lands a step off and nothing looks broken enough
 * to catch.
 */
test("no token reuses a design-system name that means something else", () => {
  assert.ok(!css.includes("--surface-2"), "`--surface-2` means #1a2030 in the design system; this console's step is `--elev-2`");
});

/** The light block, asserted to exist — a "same tokens" test that quietly skips when it cannot
 *  find the theme is the always-green guard this repo keeps writing rules about. */
function lightBlock(): string {
  const m = css.match(/\[data-theme="light"\][^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m?.[1], "no :root[data-theme=\"light\"] block in app.css — the light theme is gone, not merely unstyled");
  return m[1];
}

test("light and dark define the same tokens — a theme with a hole shows it on the flip", () => {
  const lightTokens = new Set(Object.keys(tokensIn(lightBlock())));
  const missing = Object.keys(DARK).filter((t) => !lightTokens.has(t));
  assert.deepEqual(missing, [], `defined in dark but not in light: ${missing.join(", ")}`);
});

test("no light token is simply the dark one repeated", () => {
  const light = tokensIn(lightBlock());
  const same = Object.entries(DARK).filter(([name, dark]) => light[name] === dark);
  assert.deepEqual(same, [], `these were copied from dark rather than chosen for paper: ${same.map(([n]) => n).join(", ")}`);
});

/**
 * The brand green at #2bf5a0 measures ~1.4:1 on paper — it disappears. Light deepens it, and
 * this is the check that a future "keep the brand consistent" edit does not put the neon back.
 */
test("light deepens the green instead of inheriting the neon", () => {
  const light = tokensIn(lightBlock());
  assert.notEqual(light["--primary"], DARK["--primary"], "the dark green is unreadable on paper");
  assert.equal(light["--primary-ink"], "#ffffff", "a deepened green needs white ink on it");
  // Not a custom property, so it is read off the block text rather than the token map.
  assert.match(lightBlock(), /color-scheme:\s*light/, "without color-scheme the UA keeps dark scrollbars and form controls");
});

/**
 * Elevation inverts between themes: dark stacks sidebar (darkest) → bg → card → elev-2, while
 * paper puts the page ABOVE the sidebar, because chrome must read as chrome in both. Checked
 * by luminance so it survives a palette change that keeps the intent.
 */
test("paper puts the sidebar below the page, and dark puts it above", () => {
  const lum = (hex: string): number => {
    const h = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  const light = tokensIn(lightBlock());
  assert.ok(lum(DARK["--sidebar"]!) < lum(DARK["--bg"]!), "dark: the sidebar is the deepest surface");
  assert.ok(lum(light["--sidebar"]!) < lum(light["--bg"]!), "light: the sidebar is a deeper paper than the page");
});

/** Relative luminance, then WCAG contrast. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_TOKENS = ["--fg", "--muted-fg", "--faint"] as const;
const SURFACE_TOKENS = ["--bg", "--card", "--elev-2", "--sidebar", "--sidebar-accent"] as const;

/**
 * The check that found the defect this file now pins. `--faint` was #6b7482 and measured
 * 3.50–4.29:1 — under AA on EVERY surface in the console, on live text (nav group labels,
 * field hints, row remove buttons), on every page, in the theme that has shipped all along.
 *
 * The worst surface is found by listing them ALL rather than assuming which one it is: the
 * intuition says "the page background", and the real answer is `--elev-2`, the lightest thing
 * text can land on. Derived here rather than asserted as a number, so a palette edit is
 * re-measured instead of re-declared.
 */
for (const themeName of ["dark", "light"] as const) {
  test(`${themeName}: every text tier clears AA on every surface it can land on`, () => {
    const tokens = themeName === "dark" ? tokensIn(rootBlock()) : { ...tokensIn(rootBlock()), ...tokensIn(lightBlock()) };
    const failures: string[] = [];
    for (const t of TEXT_TOKENS) {
      for (const s of SURFACE_TOKENS) {
        const fg = tokens[t];
        const bg = tokens[s];
        if (!fg || !bg || !fg.startsWith("#") || !bg.startsWith("#")) continue;
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) failures.push(`${t} (${fg}) on ${s} (${bg}) = ${ratio.toFixed(2)}:1`);
      }
    }
    assert.deepEqual(failures, [], `under AA for normal text:\n  ${failures.join("\n  ")}`);
  });
}

test("the dim tiers stay distinguishable — AA is a floor, not the design", () => {
  const dark = tokensIn(rootBlock());
  assert.notEqual(dark["--faint"], dark["--muted-fg"], "raising --faint to pass AA must not flatten it into --muted-fg");
  assert.ok(
    luminance(dark["--faint"]!) < luminance(dark["--muted-fg"]!),
    "--faint is the dimmer of the two tiers; if that inverts the hierarchy reads backwards",
  );
});

/**
 * The docked save bar cancels the content column's side padding with a negative margin so it
 * spans edge to edge. Both numbers must therefore be the SAME number, and hand-copying one is
 * how it breaks: the dock shipped `20px` against a real mobile padding of `18px`, which put a
 * 397px bar in a 393px viewport and a horizontal scrollbar on every phone. Measured, then
 * derived from one token — this keeps it derived.
 */
test("the dock's inset is the content column's padding, not a copy of it", () => {
  const main = css.match(/\.main\s*\{([^}]*)\}/)?.[1] ?? "";
  const dock = css.match(/\.dock\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(main, /padding:[^;]*var\(--main-pad-x\)/, ".main must take its side padding from the token");
  assert.match(dock, /margin:[^;]*calc\(-1 \* var\(--main-pad-x\)\)/, ".dock must cancel that same token, not a literal");
  assert.match(dock, /padding:[^;]*var\(--main-pad-x\)/, ".dock must re-apply that same token");
  // Every responsive override of the column padding has to move the token, not `.main`.
  const literalOverride = /\.main\s*\{\s*padding:\s*[^;]*\d+px\s+\d+px/.test(css.replace(/var\(--main-pad-x\)/g, "TOKEN"));
  assert.equal(literalOverride, false, "a literal side padding on .main silently desyncs the dock again");
});

test("the brand green is punctuation, not paint — it never becomes a page background", () => {
  // `background: var(--primary)` on a large surface is the documented "if a screen is mostly
  // green, it is wrong" failure. Buttons and the mark tile are the legitimate uses.
  const bad = [...css.matchAll(/(\.[a-z0-9-]+)\s*\{[^}]*background:\s*var\(--primary\)[^}]*\}/gi)]
    .map((m) => m[1])
    .filter((sel) => sel !== null && !/btn|tile|mark|dot|bar|chip|pill|badge|seg/i.test(sel ?? ""));
  assert.deepEqual(bad, [], `these paint a whole surface with the brand green: ${bad.join(", ")}`);
});
