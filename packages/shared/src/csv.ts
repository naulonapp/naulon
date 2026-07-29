/**
 * CSV serialization for every export a naulon deployment hands back — pure, no I/O, so the
 * branchy part (RFC-4180 quoting + exact micro-USDC formatting) is unit-tested in isolation,
 * away from whatever route assembles the rows.
 *
 * It belongs in shared because the escaping rules are a SECURITY control, not a formatting
 * preference. The cells carry attacker-influenced values — a slug, a User-Agent — and the
 * guard below has two branches that are easy to get half-right: a re-implementation that
 * forgets the apostrophe ships a formula-injection hole, and one that applies it to numbers
 * turns the money column into text. One implementation, consumed by every export surface.
 *
 * Money stays integer micro-USDC end to end; `microToUsdc` is the ONLY place it becomes a
 * decimal, and it does so by integer ops (never a float divide) so the cents can't drift.
 */

/** A leading char a spreadsheet (Excel/Sheets/LibreOffice) treats as the start of a FORMULA
 *  when the CSV is opened. A cell like `=…`, `+…`, `-…`, `@…`, or one led by a tab/CR can run
 *  a formula (DDE / data-exfil) on open — "CSV formula injection". */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Quote one CSV field per RFC 4180: wrap in double-quotes (doubling any embedded quote) IFF
 *  it contains a comma, quote, CR or LF; otherwise emit it bare. A slug like `a,b` or a value
 *  with a newline therefore can't break the column grid.
 *
 *  Formula-injection guard: a STRING field whose first char is a formula trigger is prefixed
 *  with an apostrophe (the spreadsheet "this is literal text" convention) and force-quoted, so
 *  an attacker-influenced cell (e.g. a slug like `=cmd|…`) can't execute when a publisher opens
 *  the export. NUMBERS are exempt — they're values we emit (epoch ms, micro-USDC), and a leading
 *  `-` on a number is a legitimate sign, not an injection; prefixing it would turn a numeric
 *  column into text and break math on the money export. */
export function csvField(value: string | number): string {
  if (typeof value === "string" && FORMULA_TRIGGER.test(value)) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize a header row + data rows to a CSV string. CRLF line endings + a trailing CRLF,
 *  per RFC 4180 (what Excel and Sheets expect). */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string {
  return [headers, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Integer micro-USDC → an exact fixed-6 decimal string (1234 → "0.001234", 1_500_000 →
 *  "1.500000"). Splits on the 1e6 boundary with integer ops — no float divide — so it
 *  reconciles exactly with the integer money kept everywhere else. */
export function microToUsdc(micro: number): string {
  const n = Math.abs(Math.trunc(micro));
  const whole = Math.trunc(n / 1_000_000);
  const frac = (n % 1_000_000).toString().padStart(6, "0");
  return `${micro < 0 ? "-" : ""}${whole}.${frac}`;
}
