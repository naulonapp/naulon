/**
 * catalogSource — the fleet/publisher catalog endpoint. Accepts both the legacy
 * bare `Candidate[]` shape and the paginated `{ entries, nextCursor }` envelope,
 * following the cursor to the end. agentFetch is unconfigured in tests, so it
 * degrades to a plain `globalThis.fetch` we stub here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogSource, rssSource } from "./discovery.ts";

function stubFetch(handler: (url: string) => Response): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    return handler(url);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("catalogSource accepts a bare Candidate[] (legacy shape)", async () => {
  const f = stubFetch(() => json([{ slug: "a", title: "A", summary: "" }]));
  try {
    const cands = await catalogSource("https://x.test/api/catalog").discover("topic");
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.slug, "a");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("catalogSource accepts { entries, nextCursor } and pages until nextCursor is absent", async () => {
  const f = stubFetch((url) =>
    url.includes("cursor=p2")
      ? json({ entries: [{ slug: "b", title: "B", summary: "" }] })
      : json({ entries: [{ slug: "a", title: "A", summary: "" }], nextCursor: "p2" }),
  );
  try {
    const cands = await catalogSource("https://x.test/api/catalog").discover("topic");
    assert.deepEqual(cands.map((c) => c.slug), ["a", "b"]);
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test("catalogSource carries indicative price fields through when present", async () => {
  const f = stubFetch(() =>
    json([{ slug: "a", title: "A", summary: "", priceUsdc: 0.02, citationPriceUsdc: 0.1 }]),
  );
  try {
    const [c] = await catalogSource("https://x.test/api/catalog").discover("topic");
    assert.equal(c!.priceUsdc, 0.02);
    assert.equal(c!.citationPriceUsdc, 0.1);
  } finally {
    f.restore();
  }
});

// ── No fail-open: a failed fetch is an error, never fabricated fixtures ─────────

test("catalogSource THROWS on a failed fetch — never substitutes demo fixtures", async () => {
  const f = stubFetch(() => new Response("nope", { status: 502 }));
  try {
    await assert.rejects(
      () => catalogSource("https://x.test/api/catalog").discover("topic"),
      /catalog fetch failed/i,
      "a 502 must throw, not resolve to bundled demo data wearing the shape of a real catalog",
    );
  } finally {
    f.restore();
  }
});

test("catalogSource THROWS on a mid-pagination failure — never silently truncates", async () => {
  const f = stubFetch((url) =>
    url.includes("cursor=p2")
      ? new Response("nope", { status: 500 })
      : json({ entries: [{ slug: "a", title: "A", summary: "" }], nextCursor: "p2" }),
  );
  try {
    await assert.rejects(
      () => catalogSource("https://x.test/api/catalog").discover("topic"),
      /catalog fetch failed/i,
      "a failure after page 1 must throw, not return the partial first page as if complete",
    );
  } finally {
    f.restore();
  }
});

test("rssSource THROWS on a failed fetch — never substitutes demo fixtures", async () => {
  const f = stubFetch(() => new Response("nope", { status: 503 }));
  try {
    await assert.rejects(
      () => rssSource("https://x.test/rss.xml").discover("topic"),
      /rss fetch failed/i,
    );
  } finally {
    f.restore();
  }
});

test("rssSource returns [] (honest empty) when a valid feed parses to zero candidates", async () => {
  // A clean 200 that parses empty is honest-empty, NOT an error and NOT demo:
  // parseRss is lenient, so [] means "no items" and the pipeline finds nothing.
  const f = stubFetch(() =>
    new Response(`<?xml version="1.0"?><rss><channel></channel></rss>`, {
      status: 200,
      headers: { "content-type": "application/xml" },
    }),
  );
  try {
    const cands = await rssSource("https://x.test/rss.xml").discover("topic");
    assert.deepEqual(cands, [], "an empty feed yields [], never the bundled demo catalog");
  } finally {
    f.restore();
  }
});
