import assert from "node:assert/strict";
import { test } from "node:test";
import { MARK, BRAND, markSvg, tileSvg } from "./brand.ts";

test("the mark geometry is the published one", () => {
  assert.equal(MARK.viewBox, "0 0 24 24");
  assert.equal(MARK.arch, "M5.5 19.5V11a6.5 6.5 0 0 1 13 0v8.5");
  assert.equal(MARK.strokeWidth, 2.3);
  assert.deepEqual({ ...MARK.coin }, { cx: 12, cy: 13.2, r: 1.85 });
});

test("the brand green and ink are the published ones", () => {
  assert.equal(BRAND.green, "#2bf5a0");
  assert.equal(BRAND.ink, "#04130c");
  assert.equal(BRAND.markScale, 0.58);
});

test("markSvg draws the arch and the coin in currentColor", () => {
  const svg = markSvg();
  assert.ok(svg.includes(MARK.arch));
  assert.ok(svg.includes('stroke="currentColor"'));
  assert.ok(svg.includes('fill="currentColor"'));
  assert.ok(!svg.includes(BRAND.green), "the bare mark must not hardcode the green");
});

test("tileSvg fills the tile with the brand green and centers the mark", () => {
  const svg = tileSvg(32);
  assert.ok(svg.includes(`fill="${BRAND.green}"`));
  assert.ok(svg.includes(`viewBox="0 0 32 32"`));
  // 32 * 0.58 = 18.56 inner; offset = (32 - 18.56) / 2 = 6.72
  assert.ok(svg.includes("translate(6.72 6.72)"));
});
