#!/usr/bin/env node
/**
 * The machine-checkable half of this project's writing rule (see CONTRIBUTING.md).
 *
 * One module, two planes, because the defect is one defect:
 *
 *   commit-msg  — the message a `git commit` is about to write
 *   files       — the prose a stranger reads: README, CONTRIBUTING, DEPLOY,
 *                 CHANGELOG, docs/, apps/portal/content/
 *
 * It is deliberately mechanical. It closes the tells a machine can see with no
 * false positives; tone, tricolons and a paragraph that explains instead of asks
 * stay a judgment call, held to the rule rather than to this file.
 *
 * Portable by design: no dependencies, no repo-specific paths, plain Node. The
 * public sibling and the plugin-marketplace repo carry byte-identical copies, so
 * a fix here is a fix there. Keep them identical.
 *
 * The document it cites differs per repo, so the citation is `PROSE_VOICE_RULE` rather than a
 * fork of this file. The default is CONTRIBUTING.md, which is where an open repo writes it down.
 *
 * Usage:
 *   node scripts/prose-voice.mjs commit-msg <file>     # exit 1 on a violation
 *   node scripts/prose-voice.mjs files <path>...       # exit 1 on a violation
 */

import { readFileSync } from "node:fs";

/** Where this repo writes the rule down. Overridden by the caller when it lives elsewhere. */
const RULE = process.env.PROSE_VOICE_RULE ?? "CONTRIBUTING.md";

/** The tell that makes prose read as generated. */
export const EM_DASH = "—";

/**
 * A trailer some tool appends on its own. The PATTERN is supplied by the caller through
 * `PROSE_VOICE_TRAILERS`, never hardcoded here, for two reasons that both matter.
 *
 * `Co-Authored-By:` is a legitimate git trailer in open source, so a blanket ban would be
 * wrong in a public repo. And this file is copied verbatim into two public repos: a pattern
 * naming a specific vendor would itself be the fingerprint it exists to remove.
 *
 * Unset means the check is off, which is the correct default for a repo with real co-authors.
 */
let trailerCache = { source: undefined, pattern: null };
function trailers() {
  const source = process.env.PROSE_VOICE_TRAILERS;
  if (source !== trailerCache.source) {
    trailerCache = { source, pattern: source ? new RegExp(source, "iu") : null };
  }
  return trailerCache.pattern;
}

/** Conventional Commits, plus the three shapes git itself writes. */
const CONVENTIONAL =
  /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert|release)(\([^()]+\))?!?: .+/;
const GIT_OWN = /^(Merge |Revert "|fixup! |squash! |Reapply )/;

const SUBJECT_MAX = 72;

/**
 * A subject opening with one of these is describing a finding, not a change.
 * "the middleware answers /license.xml itself" is a report headline; a commit
 * subject completes "applied, this commit will ...", so it starts with a verb.
 */
const NARRATIVE_OPENERS = new Set([
  "the", "a", "an", "this", "that", "these", "those",
  "it", "we", "i", "our", "my", "there", "here",
]);

/**
 * Words that give away a session journal rather than a description of a change.
 * Matched on the whole message, subject and body, case-insensitively.
 */
const JOURNAL = [
  [/\bturns out\b/i, "“turns out” narrates the investigation"],
  [/\bas (?:it )?turned out\b/i, "narrates the investigation"],
  [/\bI (?:found|noticed|realised|realized|discovered|decided|think|tried)\b/, "first person narrates the author, not the change"],
  [/\bwe (?:found|noticed|realised|realized|discovered)\b/i, "narrates the investigation"],
  // `let's` needs its apostrophe: `lets` is an ordinary verb ("moved lets a wallet spend").
  [/\blet's\b/i, "an instruction to the reader, not a description of the change"],
  // Only `this`, never `the`: a sweep, a pass and a session are all real nouns in this
  // product ("the sweep keeps refusing", "the session is anchored"), and flagging those
  // is how a guard earns its reputation for crying wolf.
  [/\bthis (?:session|pass|walk|sweep)\b/i, "names the working session, which no reader shares"],
  [/\bfound while (?:debugging|investigating|testing)\b/i, "narrates the investigation"],
];

/**
 * Strip what is not prose: fenced code, indented code, inline code spans, URLs,
 * link targets and HTML comments. A dash inside any of them is not a tell.
 */
export function prosaOnly(text) {
  // An HTML comment spanning several lines renders nowhere, so it is not prose a reader sees.
  // Collapsing it first is what makes an authoring note at the top of a document not a finding.
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const out = [];
  let fenced = false;
  for (const raw of lines) {
    const fence = /^\s{0,3}(```|~~~)/.test(raw);
    if (fence) {
      fenced = !fenced;
      out.push("");
      continue;
    }
    if (fenced || /^(\t| {4,})\S/.test(raw)) {
      out.push("");
      continue;
    }
    out.push(
      raw
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/\]\([^)]*\)/g, "](")
        .replace(/https?:\/\/\S+/g, "")
    );
  }
  return out;
}

/** Every violation in a prose file, as {line, column, rule, detail}. */
export function checkProse(text) {
  const found = [];
  prosaOnly(text).forEach((line, i) => {
    let at = line.indexOf(EM_DASH);
    while (at !== -1) {
      found.push({
        line: i + 1,
        column: at + 1,
        rule: "em-dash",
        detail: line.trim().slice(0, 120),
      });
      at = line.indexOf(EM_DASH, at + 1);
    }
    if (trailers()?.test(line)) {
      found.push({
        line: i + 1,
        column: 1,
        rule: "attribution",
        detail: line.trim().slice(0, 120),
      });
    }
  });
  return found;
}

/** Every violation in a commit message, as {rule, detail}. */
export function checkCommitMessage(message) {
  // A comment line is git's own scaffolding and never reaches the log.
  const body = message
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const lines = body.split("\n");
  const subject = (lines[0] ?? "").trim();
  const found = [];

  if (!subject) return [{ rule: "empty", detail: "the message has no subject" }];
  if (GIT_OWN.test(subject)) return [];

  if (!CONVENTIONAL.test(subject)) {
    found.push({
      rule: "conventional",
      detail: `subject is not \`type(scope): summary\`: ${subject}`,
    });
  }
  if (subject.length > SUBJECT_MAX) {
    found.push({
      rule: "subject-length",
      detail: `${subject.length} characters, the limit is ${SUBJECT_MAX}`,
    });
  }
  if (/[.!?]$/.test(subject)) {
    found.push({ rule: "subject-punctuation", detail: "subject ends in punctuation" });
  }

  const colon = subject.indexOf(": ");
  const summary = colon === -1 ? subject : subject.slice(colon + 2);
  const first = (summary.match(/[A-Za-z']+/) ?? [""])[0].toLowerCase();
  if (NARRATIVE_OPENERS.has(first)) {
    found.push({
      rule: "not-imperative",
      detail: `the summary opens with "${first}", which starts a finding rather than a change`,
    });
  }

  const prose = prosaOnly(body);
  const dashed = prose.find((l) => l.includes(EM_DASH));
  if (dashed !== undefined) {
    found.push({ rule: "em-dash", detail: dashed.trim().slice(0, 120) });
  }
  if (trailers()?.test(body)) {
    found.push({ rule: "attribution", detail: "a machine-appended trailer" });
  }
  for (const [pattern, why] of JOURNAL) {
    const hit = prose.find((l) => pattern.test(l));
    if (hit) found.push({ rule: "journal", detail: `${why}: ${hit.trim().slice(0, 100)}` });
  }

  return found;
}

const ADVICE = {
  "em-dash":
    "Em dashes are the tell that makes prose read as generated. Use a full stop, a\n" +
    "comma or a colon. The clause after the dash is usually an appositive restating\n" +
    "the clause before it, so the fix is nearly always to delete it.",
  attribution:
    "This repo ships no machine-appended trailer. A tool adds one by default, which is\n" +
    "exactly why it is checked rather than trusted.",
  conventional:
    "Use `type(scope): summary`. The types are feat, fix, docs, chore, refactor,\n" +
    "test, perf, build, ci, style, revert, release.",
  "subject-length":
    `Keep the subject within ${SUBJECT_MAX} characters. A subject that needs more is\n` +
    "usually two commits, or a finding that belongs in the body.",
  "subject-punctuation": "A commit subject is a label, not a sentence.",
  "not-imperative":
    "Write what the commit does: `fix(gate): resolve the publisher from Host`, not\n" +
    "`fix(gate): the gate answered any Host`. The reader wants the change; the\n" +
    "finding belongs in the body or in a report.",
  journal:
    "A commit records the change, not the work that produced it. Move the narrative\n" +
    "to the body as a plain statement of cause, or to a report, and cite it.",
  empty: "Write a subject.",
};

function reportAndExit(violations, header) {
  if (violations.length === 0) process.exit(0);
  console.error(header);
  console.error("");
  const seen = new Set();
  for (const v of violations) {
    console.error(`  ${v.where ? v.where + " " : ""}${v.rule}: ${v.detail}`);
    seen.add(v.rule);
  }
  console.error("");
  for (const rule of seen) if (ADVICE[rule]) console.error(ADVICE[rule] + "\n");
  console.error(`Rule: ${RULE}`);
  process.exit(1);
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "commit-msg") {
    const file = rest[0];
    if (!file) {
      console.error("usage: prose-voice.mjs commit-msg <file>");
      process.exit(2);
    }
    const violations = checkCommitMessage(readFileSync(file, "utf8"));
    reportAndExit(violations, "BLOCKED: this commit message does not meet the writing rule.");
  } else if (mode === "files") {
    const violations = [];
    for (const path of rest) {
      for (const v of checkProse(readFileSync(path, "utf8"))) {
        violations.push({ ...v, where: `${path}:${v.line}:${v.column}` });
      }
    }
    reportAndExit(
      violations,
      `BLOCKED: ${violations.length} violation(s) in prose a stranger reads.`
    );
  } else {
    console.error("usage: prose-voice.mjs <commit-msg|files> <path>...");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
