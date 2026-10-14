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
