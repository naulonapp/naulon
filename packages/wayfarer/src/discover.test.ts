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
    // The refusal must be actionable, not a dead-end: it names every env var that
    // fixes it, points at the turnkey hosted path, and states plainly that there
    // is no bundled demo (so a reader stops looking for the zero-config catalog
    // the old tool description wrongly advertised).
    const err = await discover("payment and passage").then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    assert.ok(err, "expected discover to reject");
    for (const needle of ["RSS_URL", "PUBLISHER_URL", "CATALOG_URL"]) {
      assert.ok(err!.includes(needle), `refusal must mention ${needle}; got: ${err}`);
    }
    // Vendor-neutral: names the hosted path generically, never a literal fleet
    // host (the OSS package is self-hostable — see the README <your-naulon-host>
    // placeholder — so hardcoding a URL here would be the same drift we're killing).
    assert.match(err!, /hosted .*endpoint/i, "refusal must point at the hosted path generically");
    assert.doesNotMatch(err!, /naulon\.app/i, "refusal must not hardcode a commercial fleet host");
    assert.match(err!, /no bundled demo/i, "refusal must state there is no bundled demo catalog");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
});
