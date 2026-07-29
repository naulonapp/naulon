import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCrawlers, writeCrawlers, isPolicyRestartPending } from "./crawlers.ts";

const tmpFile = async (contents?: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "naulon-crawlers-"));
  const path = join(dir, "crawler-policy.json");
  if (contents !== undefined) await writeFile(path, contents, "utf8");
  return path;
};

test("no policy file is the normal state, not an error", async () => {
  const v = await readCrawlers(join(tmpdir(), "naulon-does-not-exist", "policy.json"));
  assert.equal(v.absent, true);
  assert.equal(v.problem, null);
  assert.equal(v.empty, true);
  assert.ok(v.crawlers.length > 0, "the curated registry still renders");
  assert.ok(v.crawlers.every((c) => c.state === "default"));
});

test("a stored policy projects onto the registry", async () => {
  const path = await tmpFile(JSON.stringify({ allow: ["googlebot"], block: ["bytespider"], charge: ["gptbot"] }));
  const v = await readCrawlers(path);
  assert.equal(v.problem, null);
  assert.equal(v.empty, false);
  const byFrag = new Map(v.crawlers.map((c) => [c.fragment, c]));
  assert.equal(byFrag.get("googlebot")?.state, "allow");
  assert.equal(byFrag.get("bytespider")?.state, "block");
  assert.equal(byFrag.get("gptbot")?.state, "charge");
  assert.equal(byFrag.get("ccbot")?.state, "default");
});

test("block wins the read, matching the order the gate applies", async () => {
  // The gate's precedence is block-before-classify, so a fragment somehow in both lists
  // is BLOCKED at runtime. Reading it as `allow` would show a state the gate would not
  // apply. (The validator refuses writing such a policy — this is for one it never saw.)
  const path = await tmpFile(JSON.stringify({ allow: ["gptbot"], block: ["gptbot"] }));
  const v = await readCrawlers(path);
  // The validator refuses the overlap, so nothing applies and the operator is told why.
  assert.match(v.problem ?? "", /both allow and block/);
  assert.equal(v.empty, true);
});

test("a fragment the registry does not know is listed as the operator's own rule", async () => {
  const path = await tmpFile(JSON.stringify({ allow: [], block: ["scrapybot"] }));
  const v = await readCrawlers(path);
  assert.deepEqual(v.custom, [{ fragment: "scrapybot", state: "block" }]);
});

test("malformed JSON leaves the gate open and says so", async () => {
  const path = await tmpFile("{not json");
  const v = await readCrawlers(path);
  assert.match(v.problem ?? "", /not valid JSON/);
  assert.equal(v.empty, true, "nothing is applied — a typo must not take a site offline");
});

test("a policy that would gate humans is refused, and nothing is written", async () => {
  // The whole reason the validator lives in shared next to the gate: "mozilla" is a
  // substring of every real browser UA, so blocking it 403s every human reader.
  const path = await tmpFile();
  const r = await writeCrawlers({ allow: [], block: ["mozilla"] }, path);
  assert.equal(r.written, false);
  assert.match(r.error ?? "", /real browser user-agent/);
  assert.match(r.error ?? "", /humans read free/);
  const v = await readCrawlers(path);
  assert.equal(v.absent, true, "the refused write left no file behind");
});

test("a valid policy round-trips through the file the gate reads", async () => {
  const path = await tmpFile();
  const r = await writeCrawlers({ allow: ["googlebot"], block: ["bytespider"], charge: ["gptbot"] }, path);
  assert.equal(r.written, true);
  assert.deepEqual(r.policy, { allow: ["googlebot"], block: ["bytespider"], charge: ["gptbot"] });
  const onDisk = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(onDisk, { allow: ["googlebot"], block: ["bytespider"], charge: ["gptbot"] });
  assert.equal((await readCrawlers(path)).empty, false);
});

test("fragments are normalized on the way in, so stored intent equals matched intent", async () => {
  const path = await tmpFile();
  await writeCrawlers({ allow: ["  GoogleBot  ", "googlebot"], block: [] }, path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).allow, ["googlebot"], "trimmed, lowercased, deduped");
});

test("an empty charge list is omitted rather than stored as []", async () => {
  const path = await tmpFile();
  const r = await writeCrawlers({ allow: ["googlebot"], block: [], charge: [] }, path);
  assert.equal(r.written, true);
  assert.equal("charge" in (r.policy ?? {}), false);
});

test("a control character is refused — the fragment is echoed into a response header", async () => {
  const path = await tmpFile();
  const r = await writeCrawlers({ allow: [], block: ["bad\r\nX-Injected: 1"] }, path);
  assert.equal(r.written, false);
  assert.match(r.error ?? "", /control character/);
});

test("restart drift: an edit after the gate booted is saved but not enforced", () => {
  const started = "2026-07-29T12:00:00.000Z";
  assert.equal(
    isPolicyRestartPending({ fileModifiedAt: Date.parse(started) + 60_000, gateStartedAt: started, gateUp: true }),
    true,
  );
  assert.equal(
    isPolicyRestartPending({ fileModifiedAt: Date.parse(started) - 60_000, gateStartedAt: started, gateUp: true }),
    false,
  );
  // A gate that is down has no "currently serving" policy to be stale against.
  assert.equal(
    isPolicyRestartPending({ fileModifiedAt: Date.parse(started) + 60_000, gateStartedAt: started, gateUp: false }),
    false,
  );
  assert.equal(
    isPolicyRestartPending({ fileModifiedAt: null, gateStartedAt: started, gateUp: true }),
    false,
  );
});
