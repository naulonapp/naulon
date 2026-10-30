import { readdirSync } from "node:fs";

/**
 * The font files the console serves, read from `public/fonts/` once at boot. A request is matched
 * against this set by exact name, so no path is ever built from the URL. Listing the directory
 * rather than naming the files keeps the set in step with the stylesheet: a hand-kept list went on
 * naming the previous typefaces after the files changed, and every page fell back to system fonts.
 */
export const CONSOLE_FONTS: ReadonlySet<string> = new Set(
  readdirSync(new URL("./public/fonts/", import.meta.url)).filter((f) => f.endsWith(".woff2")),
);

/** Every `/fonts/<file>` a stylesheet asks for. */
export function fontUrlsIn(css: string): string[] {
  return [...css.matchAll(/url\(["']?\/fonts\/([^"')]+)["']?\)/g)].map((m) => m[1]!);
}
