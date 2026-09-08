/**
 * The credits URL a publisher's API actually receives.
 *
 * Untested until 2026-09-09, and the gap was load-bearing: the resolver percent-encoded the WHOLE
 * slug, so a hierarchical slug arrived as `2026%2F09%2F08%2Fpost` and Apache answered 404 before
 * WordPress ran. A 404 is this contract's "free read" signal, so a stock WordPress install — dated
 * permalinks are the default — was silently untollable while both sides reported healthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { httpResolver } from "./http.ts";

const CREDITS = {
  slug: "2026/09/08/paid-article",
  title: "Paid article",
  contributors: [{ authorId: "wp-user-2", wallet: "0x1111111111111111111111111111111111111111" }],
};

function capture(status = 200, body: unknown = CREDITS) {
  const seen: string[] = [];
  const impl = async (url: string | URL) => {
    seen.push(String(url));
    return new Response(status === 404 ? "" : JSON.stringify(body), { status });
  };
  return { seen, impl: impl as unknown as typeof fetch };
}

test("a hierarchical slug keeps its slashes — they are path separators, not data", async () => {
  const { seen, impl } = capture();
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await httpResolver("https://site.example/wp-json/naulon/v1").resolve("2026/09/08/paid-article");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0], "https://site.example/wp-json/naulon/v1/credits/2026/09/08/paid-article");
  assert.ok(!seen[0]!.includes("%2F"), "a %2F here is a 404 at the origin, read as a free article");
});

test("characters inside a segment are still escaped", async () => {
  const { seen, impl } = capture();
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await httpResolver("https://site.example/api").resolve("2026/a b?c#d");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0], "https://site.example/api/credits/2026/a%20b%3Fc%23d");
});

test("a slug cannot climb out of the credits path", async () => {
  const r = httpResolver("https://site.example/api");
  for (const bad of ["../../etc/passwd", "2026/../../secret", "a//b", "/leading", "trailing/"]) {
    await assert.rejects(() => r.resolve(bad), /unusable path segment/, `refused: ${bad}`);
  }
});

test("404 is still the free-read signal", async () => {
  const { impl } = capture(404);
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    assert.equal(await httpResolver("https://site.example/api").resolve("free-one"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});
