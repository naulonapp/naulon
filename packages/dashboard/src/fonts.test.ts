import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CONSOLE_FONTS, fontUrlsIn } from "./fonts.ts";

const PUBLIC = new URL("./public/", import.meta.url);
const sheets = readdirSync(PUBLIC).filter((f) => f.endsWith(".css"));

test("every font a stylesheet asks for is one the console serves", () => {
  const asked = sheets.flatMap((f) => fontUrlsIn(readFileSync(new URL(f, PUBLIC), "utf8")));
  assert.ok(asked.length > 0, "no stylesheet names a font, so this reads nothing");
  for (const file of asked) assert.ok(CONSOLE_FONTS.has(file), `${file} is linked but not served`);
});

test("fontUrlsIn reads quoted and bare urls", () => {
  assert.deepEqual(fontUrlsIn(`src: url("/fonts/a.woff2"); src: url(/fonts/b.woff2)`), ["a.woff2", "b.woff2"]);
});
