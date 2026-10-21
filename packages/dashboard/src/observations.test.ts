import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.OBSERVATIONS_BACKEND = "jsonl";
const { readObservations } = await import("./observations.ts");

const NOW = 1_800_000_000_000;
const row = (id: string, at = NOW) =>
  JSON.stringify({ id, host: "x", slug: "s", verdict: "denied", classifiedAs: "agent", at }) + "\n";
const fresh = () => join(mkdtempSync(join(tmpdir(), "naulon-follow-")), "observations.jsonl");
const ids = async (file: string) => (await readObservations(file, NOW)).map((o) => o.id);

test("no file reads as no traffic", async () => {
  assert.deepEqual(await ids(fresh()), []);
});

test("appended rows are picked up on the next read", async () => {
  const file = fresh();
  writeFileSync(file, row("a") + row("b"));
  assert.deepEqual(await ids(file), ["a", "b"]);
  appendFileSync(file, row("c"));
  assert.deepEqual(await ids(file), ["a", "b", "c"]);
});

test("a line the gate is still writing waits for its newline", async () => {
  const file = fresh();
  const whole = row("a");
  writeFileSync(file, whole.slice(0, 20));
  assert.deepEqual(await ids(file), []);
  appendFileSync(file, whole.slice(20));
  assert.deepEqual(await ids(file), ["a"]);
});

test("a rotation reads the moved file and the new one, oldest first", async () => {
  const file = fresh();
  writeFileSync(file, row("a") + row("b"));
  assert.deepEqual(await ids(file), ["a", "b"]);
  renameSync(file, `${file}.1`);
  writeFileSync(file, row("c"));
  assert.deepEqual(await ids(file), ["a", "b", "c"]);
});

test("a truncated file is read again from the start", async () => {
  const file = fresh();
  writeFileSync(file, row("a") + row("b") + row("c"));
  await ids(file);
  writeFileSync(file, row("d"));
  assert.deepEqual(await ids(file), ["d"]);
});

test("rows older than the widest console window are let go", async () => {
  const file = fresh();
  writeFileSync(file, row("old", NOW - 8 * 24 * 3_600_000) + row("new"));
  assert.deepEqual(await ids(file), ["new"]);
});

test("a malformed row is skipped, not fatal", async () => {
  const file = fresh();
  writeFileSync(file, row("a") + "{not json\n" + row("b"));
  assert.deepEqual(await ids(file), ["a", "b"]);
});

test("overlapping reads never count a row twice", async () => {
  const file = fresh();
  writeFileSync(file, row("a"));
  await ids(file);
  appendFileSync(file, row("b") + row("c"));
  const [x, y] = await Promise.all([ids(file), ids(file)]);
  assert.deepEqual(x, ["a", "b", "c"]);
  assert.deepEqual(y, ["a", "b", "c"]);
});
