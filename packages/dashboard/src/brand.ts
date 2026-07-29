/**
 * The naulon mark, pinned. A toll-gateway arch (reads as the "n" of naulon) holding
 * a coin — monoline, `currentColor`, no text, so it stays crisp from a 16px favicon
 * up to a lockup. These numbers ARE the brand; the published kit at
 * https://naulon.app/brand is the source of truth and `brand.test.ts` locks them, so
 * a silent edit fails the suite.
 *
 * Pure data + string builders. No fs, no deps — safe to import anywhere.
 */
export const MARK = {
  viewBox: "0 0 24 24",
  arch: "M5.5 19.5V11a6.5 6.5 0 0 1 13 0v8.5",
  strokeWidth: 2.3,
  coin: { cx: 12, cy: 13.2, r: 1.85 },
} as const;

/** Brand green + the ink that sits on it. `markScale` = the mark fills 58% of its tile. */
export const BRAND = {
  green: "#2bf5a0",
  ink: "#04130c",
  markScale: 0.58,
  tileRadiusRatio: 0.21875, // 14/64 — exact at 32px (→7) and 64px (→14)
} as const;

const SVG_NS = "http://www.w3.org/2000/svg";
const round = (n: number): number => Number(n.toFixed(4));

/** The two mark primitives (arch + coin) in a given color. */
function glyph(color: string): string {
  return (
    `<path d="${MARK.arch}" stroke="${color}" stroke-width="${MARK.strokeWidth}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${MARK.coin.cx}" cy="${MARK.coin.cy}" r="${MARK.coin.r}" fill="${color}"/>`
  );
}

/** Bare mark, `currentColor` — recolor by setting `color`. */
export function markSvg(): string {
  return (
    `<svg xmlns="${SVG_NS}" viewBox="${MARK.viewBox}" fill="none" aria-hidden="true">` +
    `${glyph("currentColor")}</svg>`
  );
}

/** The mark on the brand-green tile. Same builder serves the favicon. */
export function tileSvg(size = 64): string {
  const rx = round(size * BRAND.tileRadiusRatio);
  const inner = size * BRAND.markScale;
  const scale = round(inner / 24);
  const off = round((size - inner) / 2);
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${size} ${size}" role="img" aria-label="naulon">` +
    `<rect width="${size}" height="${size}" rx="${rx}" fill="${BRAND.green}"/>` +
    `<g fill="none" transform="translate(${off} ${off}) scale(${scale})">${glyph(BRAND.ink)}</g></svg>`
  );
}
