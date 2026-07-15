/**
 * catalogSource — the fleet/publisher catalog endpoint. Accepts both the legacy
 * bare `Candidate[]` shape and the paginated `{ entries, nextCursor }` envelope,
 * following the cursor to the end. agentFetch is unconfigured in tests, so it
 * degrades to a plain `globalThis.fetch` we stub here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogSource } from "./discovery.ts";

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
