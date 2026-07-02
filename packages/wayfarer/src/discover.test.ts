/**
 * Discovery's offline path: with no CATALOG_URL, the agent falls back to the
 * bundled demo catalog so the loop runs with no publisher backend.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfig } from "@naulon/shared";
import { discover } from "./discover.ts";

test("falls back to the bundled demo catalog when no CATALOG_URL is set", async () => {
  const had = process.env.CATALOG_URL;
  delete process.env.CATALOG_URL;
  resetConfig();
  try {
    const cands = await discover("payment and passage");
    assert.ok(cands.length > 0, "demo catalog is non-empty");
    // Each candidate is a free teaser: slug + title + summary, no price yet.
    for (const c of cands) {
      assert.equal(typeof c.slug, "string");
      assert.equal(typeof c.title, "string");
      assert.equal(typeof c.summary, "string");
    }
    // The demo catalog mirrors examples/meridian/credits.json slugs.
    assert.ok(cands.some((c) => c.slug === "the-naulon"));
  } finally {
    if (had !== undefined) process.env.CATALOG_URL = had;
    resetConfig();
  }
});
