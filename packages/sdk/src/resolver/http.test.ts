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
import { httpResolver, encodeSlugPath } from "./http.ts";

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

test("a slug cannot climb out of the credits path", () => {
  for (const bad of ["../../etc/passwd", "2026/../../secret", "a//b", ".", "..", "/", ""]) {
    assert.throws(() => encodeSlugPath(bad), /unusable path segment/, `refused: ${bad}`);
  }
});

/* The two slug shapes the gate itself produces carry an OUTER slash — `slugFromSitePath` returns
 * the full pathname, and `slugFromPath` under depth:"rest" keeps a trailing one. Refusing those
 * turned every site-mode tenant with a credits API into a 503 for agents, because `resolve()` is
 * reached from `quote()` with no try/catch above it. */
test("the gate's own slug shapes are addressable, not refused", () => {
  assert.equal(encodeSlugPath("/blog/post"), "blog/post");
  assert.equal(encodeSlugPath("/2026/09/08/on-stillness/"), "2026/09/08/on-stillness");
  assert.equal(encodeSlugPath("/about"), "about");
});

test("an unusable slug is a FREE READ, never a 503", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  try {
    const r = httpResolver("https://site.example/api");
    assert.equal(await r.resolve("../../etc/passwd"), undefined);
    assert.equal(called, false, "nothing was fetched for a slug this contract cannot address");
  } finally {
    globalThis.fetch = original;
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
