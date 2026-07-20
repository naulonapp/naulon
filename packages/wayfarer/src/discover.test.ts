/**
 * Discovery's no-config path: with no discovery source configured, the agent
 * must REFUSE (throw), not silently fall back to bundled demo fixtures. A failed
 * or absent source is a config error surfaced at the seam — never fabricated
 * data wearing the shape of a real catalog.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfig } from "@naulon/shared";
import { discover } from "./discover.ts";

test("THROWS when no discovery source is configured — never a bundled demo fallback", async () => {
  const saved = {
    CATALOG_URL: process.env.CATALOG_URL,
    RSS_URL: process.env.RSS_URL,
    PUBLISHER_URL: process.env.PUBLISHER_URL,
  };
  delete process.env.CATALOG_URL;
  delete process.env.RSS_URL;
  delete process.env.PUBLISHER_URL;
  resetConfig();
  try {
    await assert.rejects(
      () => discover("payment and passage"),
      /no discovery source configured/i,
      "with nothing set, discover must throw, not return demo fixtures",
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
});
