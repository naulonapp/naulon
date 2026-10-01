import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCrawlerPolicyFile } from "./crawlerPolicyFile.ts";

const file = (body: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), "naulon-policy-")), "crawlers.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
};

test("forged: block and charge are kept", async () => {
  for (const forged of ["block", "charge"] as const) {
    const r = await readCrawlerPolicyFile(file({ allow: ["googlebot"], block: [], forged }));
    assert.equal(r.problem, null);
    assert.equal(r.policy?.forged, forged);
  }
});

test("forged: absent stays absent", async () => {
  const r = await readCrawlerPolicyFile(file({ allow: ["googlebot"], block: [] }));
  assert.equal(r.policy?.forged, undefined);
});

test("forged: any other value is reported and the file is not applied", async () => {
  const r = await readCrawlerPolicyFile(file({ allow: ["googlebot"], block: [], forged: "maybe" }));
  assert.equal(r.policy, undefined);
  assert.match(r.problem ?? "", /forged must be "charge" or "block"/);
});
