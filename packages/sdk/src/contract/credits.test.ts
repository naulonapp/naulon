import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCredits, buildCredits } from "./credits.ts";

const valid = {
  slug: "on-stillness",
  title: "On Stillness",
  contributors: [
    { authorId: "ava", wallet: "0x1111111111111111111111111111111111111111" },
  ],
};

test("accepts a well-formed leaf credits object", () => {
  assert.equal(parseCredits(valid).slug, "on-stillness");
});

test("accepts a recursive composite contributor", () => {
  const composite = {
    slug: "the-naulon",
    title: "The Naulon",
    contributors: [
      {
        authorId: "collective",
        members: [
          { authorId: "a", wallet: "0x1111111111111111111111111111111111111111" },
          { authorId: "b", wallet: "0x2222222222222222222222222222222222222222" },
        ],
      },
    ],
  };
  assert.equal(parseCredits(composite).contributors.length, 1);
});

test("rejects a malformed wallet address", () => {
  const bad = { ...valid, contributors: [{ authorId: "x", wallet: "0xnope" }] };
  assert.throws(() => parseCredits(bad), /wallet/);
});

test("rejects a contributor that is both leaf and composite", () => {
  const bad = {
    ...valid,
    contributors: [
      {
        authorId: "x",
        wallet: "0x1111111111111111111111111111111111111111",
        members: [{ authorId: "y", wallet: "0x2222222222222222222222222222222222222222" }],
      },
    ],
  };
  assert.throws(() => parseCredits(bad), /never both/);
});

/* A leaf with no wallet is a DELEGATED payee, not malformed. Refusing it is why a source with no
 * address for a contributor had to drop them, erasing that they contributed. */
test("accepts a contributor with neither wallet nor members — a delegated payee", () => {
  const parsed = parseCredits({ ...valid, contributors: [{ authorId: "x" }] });
  assert.equal(parsed.contributors[0]?.wallet, undefined);
  assert.equal(parsed.contributors[0]?.authorId, "x");
});

test("a delegated leaf still may not carry an unusable wallet", () => {
  assert.throws(
    () => parseCredits({ ...valid, contributors: [{ authorId: "x", wallet: "0xnope" }] }),
    /wallet/,
  );
});

test("rejects empty contributors", () => {
  assert.throws(() => parseCredits({ ...valid, contributors: [] }));
});

test("rejects unknown top-level fields (strict)", () => {
  assert.throws(() => parseCredits({ ...valid, payTo: "0xdeadbeef" }));
});

test("buildCredits validates and returns the same shape", () => {
  assert.equal(buildCredits(valid).title, "On Stillness");
  assert.throws(() => buildCredits({ ...valid, contributors: [] }));
});
