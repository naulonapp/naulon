/**
 * Normalization and sentence segmentation for proving quotes.
 *
 * A quote is proved sentence by sentence (see `merkle.ts`), so every party must split a text the
 * same way. These rules are frozen per package version: changing the abbreviation list or a rule
 * changes every leaf, so it is a version bump, and `EXTRACT_VERSION` is what an attestation names.
 */

export const EXTRACT_VERSION = "0.2.0";

/** NFC, every run of whitespace (including no-break and thin spaces) collapsed to one space, trimmed. */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/[\s  -​  　]+/gu, " ").trim();
}

/** Tokens that end with a full stop without ending a sentence. Compared without the stop. */
const ABBREVIATIONS = new Set([
  "al", "e.g", "i.e", "etc", "Fig", "Figs", "fig", "figs", "Eq", "Eqs", "eq", "eqs", "Ref", "Refs", "ref", "refs",
  "No", "no", "Vol", "vol", "pp", "p", "vs", "cf", "Dr", "Mr", "Mrs", "Ms", "Prof", "St", "Jr", "Sr",
  "approx", "ca", "resp", "Sect", "sect", "Suppl", "suppl", "Tab", "tab", "Ch", "ch", "Inc", "Ltd", "Co",
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
]);

/** A terminator run, any closing quotes or brackets after it, then the whitespace that follows. */
const BOUNDARY = /[.?!]+["'”’)\]]*(?=\s)/gu;
/** What may open a new sentence. */
const OPENER = /^\s+[\p{Lu}\p{N}"'“‘(\[]/u;

function isAbbreviation(text: string, stopAt: number): boolean {
  const before = text.slice(0, stopAt);
  const token = /(\S+)$/.exec(before)?.[1]?.replace(/^[(\["'“‘]+/u, "") ?? "";
  if (ABBREVIATIONS.has(token)) return true;
  // A single capital is an initial: "J. K. Rowling".
  return /^\p{Lu}$/u.test(token);
}

/** Sentences in order. Joining them with single spaces gives back the normalized input. */
export function segmentSentences(text: string): string[] {
  const t = normalizeText(text);
  if (t.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  for (const m of t.matchAll(BOUNDARY)) {
    const end = m.index + m[0].length;
    if (!OPENER.test(t.slice(end))) continue;
    // Only a lone full stop can be an abbreviation; "?" and "!" always end a sentence.
    if (m[0].startsWith(".") && !m[0].startsWith("..") && isAbbreviation(t, m.index)) continue;
    out.push(t.slice(start, end).trim());
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest.length > 0) out.push(rest);
  return out;
}
