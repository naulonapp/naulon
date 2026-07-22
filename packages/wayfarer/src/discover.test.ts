/**
 * Discovery's zero-config path (WP-2 T1): with nothing configured, CATALOG_URL now
 * defaults to the live naulon fleet directory (`@naulon/shared`'s `FLEET_DIRECTORY_URL`)
 * — `@naulon/wayfarer-mcp` is naulon's branded client, so discovery is turnkey out of
 * the box. `isFleetDefaultDiscovery` flags exactly this case (and ONLY this case) as the
 * ONE scenario where the directory's own results may later be auto-trusted as payable
 * (Task 2) — a self-hosting operator who sets RSS_URL/PUBLISHER_URL/CATALOG_URL keeps
 * the strict single-gate pin, never auto-trusted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfig } from "@naulon/shared";

test("zero-config: discovery defaults to the fleet directory, flagged as fleet-default", async () => {
  const saved = { CATALOG_URL: process.env.CATALOG_URL, RSS_URL: process.env.RSS_URL, PUBLISHER_URL: process.env.PUBLISHER_URL };
  for (const k of ["CATALOG_URL", "RSS_URL", "PUBLISHER_URL"]) delete process.env[k];
  resetConfig();
  try {
    const { getConfig, FLEET_DIRECTORY_URL, isFleetDefaultDiscovery } = await import("@naulon/shared");
    const cfg = getConfig();
    assert.equal(cfg.CATALOG_URL, FLEET_DIRECTORY_URL);
    assert.equal(isFleetDefaultDiscovery(cfg), true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
});

test("self-host: an explicit CATALOG_URL is NOT treated as fleet-default (no auto-trust)", async () => {
  const saved = process.env.CATALOG_URL;
  process.env.CATALOG_URL = "https://my.example/catalog";
  resetConfig();
  try {
    const { getConfig, isFleetDefaultDiscovery } = await import("@naulon/shared");
    assert.equal(isFleetDefaultDiscovery(getConfig()), false);
  } finally {
    if (saved === undefined) delete process.env.CATALOG_URL;
    else process.env.CATALOG_URL = saved;
    resetConfig();
  }
});

test("self-host: RSS_URL/PUBLISHER_URL is NOT treated as fleet-default even with CATALOG_URL left at its default", async () => {
  const saved = { CATALOG_URL: process.env.CATALOG_URL, RSS_URL: process.env.RSS_URL, PUBLISHER_URL: process.env.PUBLISHER_URL };
  delete process.env.CATALOG_URL;
  delete process.env.PUBLISHER_URL;
  process.env.RSS_URL = "https://my.example/rss.xml";
  resetConfig();
  try {
    const { getConfig, isFleetDefaultDiscovery } = await import("@naulon/shared");
    assert.equal(isFleetDefaultDiscovery(getConfig()), false, "an RSS-configured self-host must not be flagged fleet-default");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
});
