import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksFor, termsPolicySchema } from "./terms-policy.ts";

test("a policy with every axis stated parses", () => {
  const parsed = termsPolicySchema.parse({
    search: "free",
    "ai-input": "priced",
    "ai-index": "free",
    "ai-train": "by-agreement",
    contact: "mailto:rights@example.test",
  });
  assert.equal(parsed["ai-train"], "by-agreement");
});

test("search may not be priced — tolling indexing delists the publisher", () => {
  assert.throws(() => termsPolicySchema.parse({ search: "priced" }));
});

test("ai-train may not be priced — a corpus is negotiated, not tolled per fetch", () => {
  assert.throws(() => termsPolicySchema.parse({ "ai-train": "priced" }));
});

test("an unknown axis is refused rather than silently dropped", () => {
  assert.throws(() => termsPolicySchema.parse({ "ai-sing": "free" }));
});

test("by-agreement with no contact is refused — a grant with nobody to ask is not a grant", () => {
  assert.throws(() => termsPolicySchema.parse({ "ai-train": "by-agreement" }));
});

test("an absent axis stays absent — null means not stated, never a default", () => {
  const parsed = termsPolicySchema.parse({ "ai-input": "priced" });
  assert.equal("ai-train" in parsed, false);
});

// --- blocksFor: the policy becomes the licence set -------------------------------------------

const PRICED = { readUsdc: 0.005, citationUsdc: 0.0125, x402Network: "base" };

test("an unstated policy emits exactly the pre-0220 block set", () => {
  const blocks = blocksFor(undefined, PRICED);
  assert.deepEqual(
    blocks.map((b) => b.usage),
    [["search"], ["ai-input", "ai-index"], ["ai-input"]],
  );
  assert.equal(blocks[0]!.payment?.type, "free");
  assert.equal(blocks[1]!.payment?.type, "crawl");
  assert.equal(blocks[2]!.payment?.type, "use");
  assert.equal(
    blocks.some((b) => b.prohibits),
    false,
  );
});

test("a prohibited term leaves permits and enters prohibits", () => {
  const blocks = blocksFor({ "ai-index": "prohibit" }, PRICED);
  assert.equal(
    blocks.some((b) => b.usage.includes("ai-index")),
    false,
  );
  assert.equal(
    blocks.some((b) => b.prohibits?.includes("ai-index")),
    true,
  );
});

test("a refusal carries no payment — a price for something not on sale is a claim nobody made", () => {
  const refusal = blocksFor({ "ai-index": "prohibit" }, PRICED).find((b) => b.prohibits);
  assert.equal(refusal?.payment, undefined);
});

test("a free term is permitted at no cost", () => {
  const blocks = blocksFor({ "ai-input": "free" }, PRICED);
  const free = blocks.find((b) => b.usage.includes("ai-input"));
  assert.equal(free?.payment?.type, "free");
});

test("training given away is DECLARED free, never dropped for being the fourth axis", () => {
  const blocks = blocksFor({ "ai-train": "free" }, PRICED);
  const free = blocks.find((b) => b.usage.includes("ai-train"));
  assert.equal(free?.payment?.type, "free");
});

test("unstated ai-train stays out of both lists — silence is not an invented refusal", () => {
  const blocks = blocksFor({ "ai-input": "priced" }, PRICED);
  assert.equal(
    blocks.some((b) => b.usage.includes("ai-train") || b.prohibits?.includes("ai-train")),
    false,
  );
});

test("a site that prohibits everything priced emits no priced licence at all", () => {
  const blocks = blocksFor({ "ai-input": "prohibit", "ai-index": "prohibit" }, PRICED);
  assert.equal(
    blocks.some((b) => b.payment?.type === "crawl" || b.payment?.type === "use"),
    false,
  );
});

test("by-agreement with no contact emits no block — silence beats an unanswerable offer", () => {
  const blocks = blocksFor({ "ai-train": "by-agreement" }, PRICED);
  assert.equal(
    blocks.some((b) => b.usage.includes("ai-train")),
    false,
  );
});

test("a negotiated grant carries the contact and no amount", () => {
  const blocks = blocksFor(
    { "ai-train": "by-agreement", contact: "mailto:rights@example.test" },
    PRICED,
  );
  const training = blocks.find((b) => b.usage.includes("ai-train"));
  assert.equal(training?.payment?.type, "training");
  assert.equal(training?.payment?.amountUsdc, undefined);
  assert.equal(training?.contact, "mailto:rights@example.test");
});

test("use is offered at the read price too, so a buyer can choose citation rights at multiplier 1", () => {
  const blocks = blocksFor(undefined, { readUsdc: 0.005, citationUsdc: 0.005 });
  const use = blocks.find((b) => b.payment?.type === "use");
  assert.ok(use);
  assert.equal(use.payment?.amountUsdc, 0.005);
  assert.deepEqual(use.usage, ["ai-input"]);
});

test("no use licence when ai-input is not sold", () => {
  const blocks = blocksFor({ "ai-input": "free" }, { readUsdc: 0.005, citationUsdc: 0.005 });
  assert.equal(blocks.some((b) => b.payment?.type === "use"), false);
});
