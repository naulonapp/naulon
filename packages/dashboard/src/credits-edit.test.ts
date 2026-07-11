import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCreditsMap } from "./credits-edit.ts";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

const article = (slug: string, wallet: string) => ({
  slug,
  title: slug.replace(/-/g, " "),
  contributors: [{ authorId: "ava", wallet }],
});

test("all-valid map returns the parsed credits, no errors", () => {
  const r = validateCreditsMap({ "on-stillness": article("on-stillness", W1) });
  assert.equal(r.ok, true);
  assert.ok(r.credits?.["on-stillness"]);
  assert.deepEqual(r.errors, []);
});

test("one bad wallet rejects the WHOLE save (all-or-nothing)", () => {
  const r = validateCreditsMap({
    good: article("good", W1),
    bad: article("bad", "0xnotawallet"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.credits, undefined); // nothing write-ready — no partial payout map
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]?.slug, "bad");
});

test("flags an article whose author has no wallet as unmapped (reported, not guessed)", () => {
  const r = validateCreditsMap({
    mapped: article("mapped", W1),
    orphan: { slug: "orphan", title: "Orphan", contributors: [{ authorId: "nobody" }] },
  });
  assert.ok(r.unmapped.includes("orphan"));
  assert.ok(!r.unmapped.includes("mapped"));
});

test("detects an unmapped author nested inside members", () => {
  const r = validateCreditsMap({
    team: {
      slug: "team",
      title: "Team piece",
      contributors: [{ authorId: "desk", members: [{ authorId: "a", wallet: W1 }, { authorId: "b" }] }],
    },
  });
  assert.ok(r.unmapped.includes("team"));
});

test("empty map is valid (clears to nothing tollable)", () => {
  const r = validateCreditsMap({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.credits, {});
});

test("a split with two mapped wallets validates and is not unmapped", () => {
  const r = validateCreditsMap({
    split: {
      slug: "split",
      title: "Split",
      contributors: [{ authorId: "a", wallet: W1, weight: 2 }, { authorId: "b", wallet: W2, weight: 1 }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.unmapped.length, 0);
});
