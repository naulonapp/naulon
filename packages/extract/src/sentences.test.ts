import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXTRACT_VERSION, normalizeText, segmentSentences } from "./sentences.ts";

test("EXTRACT_VERSION is the package version, so an attestation names the rules it used", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(EXTRACT_VERSION, pkg.version);
});

test("normalization is NFC with whitespace collapsed and trimmed", () => {
  assert.equal(normalizeText("  Café\n\n  noir\t "), "Café noir");
  assert.equal(normalizeText("a b c"), "a b c");
  assert.equal(normalizeText(""), "");
});

test("abbreviations, decimals, initials, citations and et al. stay inside one sentence", () => {
  const t = "Smith et al. (2020) measured 3.5 mg/kg in vivo. Fig. 2 shows e.g. the dose. J. K. Rowling wrote it. Was it? Yes!";
  assert.deepEqual(segmentSentences(t), [
    "Smith et al. (2020) measured 3.5 mg/kg in vivo.",
    "Fig. 2 shows e.g. the dose.",
    "J. K. Rowling wrote it.",
    "Was it?",
    "Yes!",
  ]);
});

test("a closing quote or bracket stays with its sentence", () => {
  assert.deepEqual(segmentSentences('He said "stop." Then (it ended.) Done.'), ['He said "stop."', "Then (it ended.)", "Done."]);
});

test("a lowercase continuation never starts a sentence", () => {
  assert.deepEqual(segmentSentences("The value was 5 vs. the control. Next one."), ["The value was 5 vs. the control.", "Next one."]);
  assert.deepEqual(segmentSentences("It rose ca. tenfold. Then fell."), ["It rose ca. tenfold.", "Then fell."]);
});

test("segmentation is deterministic, total and lossless up to whitespace", () => {
  const t = normalizeText('A b. C d? E f! G "h." I j');
  const s = segmentSentences(t);
  assert.equal(s.join(" "), t);
  assert.deepEqual(segmentSentences(t), s);
  assert.deepEqual(segmentSentences(""), []);
  assert.deepEqual(segmentSentences("No terminator at all"), ["No terminator at all"]);
});

test("segmentation is linear in the text, so a long document cannot stall it", () => {
  const text = "Observation one was made. Fig. 2 shows it. ".repeat(20_000);
  const t0 = performance.now();
  const s = segmentSentences(text);
  const ms = performance.now() - t0;
  assert.equal(s.length, 40_000);
  assert.ok(ms < 1_000, `took ${Math.round(ms)}ms for ${text.length} characters`);
});

/** The original, slice-based rules: the reference the linear version must match exactly. */
function referenceSegment(text: string): string[] {
  const ABBR = new Set(["al", "e.g", "i.e", "etc", "Fig", "Figs", "fig", "figs", "Eq", "Eqs", "eq", "eqs", "Ref", "Refs", "ref", "refs",
    "No", "no", "Vol", "vol", "pp", "p", "vs", "cf", "Dr", "Mr", "Mrs", "Ms", "Prof", "St", "Jr", "Sr", "approx", "ca", "resp", "Sect",
    "sect", "Suppl", "suppl", "Tab", "tab", "Ch", "ch", "Inc", "Ltd", "Co", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept",
    "Oct", "Nov", "Dec"]);
  const t = normalizeText(text);
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (const m of t.matchAll(/[.?!]+["'”’)\]]*(?=\s)/gu)) {
    const end = m.index + m[0].length;
    if (!/^\s+[\p{Lu}\p{N}"'“‘(\[]/u.test(t.slice(end))) continue;
    if (m[0].startsWith(".") && !m[0].startsWith("..")) {
      const token = /(\S+)$/.exec(t.slice(0, m.index))?.[1]?.replace(/^[(\["'“‘]+/u, "") ?? "";
      if (ABBR.has(token) || /^\p{Lu}$/u.test(token)) continue;
    }
    out.push(t.slice(start, end).trim());
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

test("the linear segmentation matches the reference rules exactly, including pathological tokens", () => {
  const cases = [
    `x ${"(".repeat(40)}e.g. The next one.`,
    `z${"(".repeat(40)}e.g. The next one.`,
    `z${"\u201c".repeat(31)}J. Then.`,
    `${"(".repeat(40)}J. K. Rowling. Then.`,
    `${"a".repeat(50)}e.g. Next. ${"“".repeat(35)}Fig. 3 here.`,
    "Smith et al. (2020) measured 3.5 mg/kg in vivo. Fig. 2 shows e.g. the dose. J. K. Rowling wrote it. Was it? Yes!",
  ];
  // A seeded generator over the characters that matter, so the comparison covers shapes nobody wrote down.
  let seed = 20261014;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const alphabet = ["a", "B", "J", ".", ".", "?", "!", " ", " ", "(", "\"", "“", ")", "e.g", "Fig", "al", "3", "’"];
  for (let i = 0; i < 2000; i++) cases.push(Array.from({ length: 5 + Math.floor(rnd() * 60) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(""));
  for (const c of cases) assert.deepEqual(segmentSentences(c), referenceSegment(c), JSON.stringify(c));
});

test("a long run of terminators with no space after it stays linear", () => {
  for (const run of [".".repeat(100_000), "?!".repeat(50_000), `${".".repeat(50_000)})`.repeat(2)]) {
    const t0 = performance.now();
    segmentSentences(`Start ${run}x end.`);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `took ${Math.round(ms)}ms`);
  }
});
