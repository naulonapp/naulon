/** The one place the naulon fleet origin lives. wayfarer-mcp is naulon's branded
 *  client: zero-config discovery resolves here, overridable via env for self-host. */
export const FLEET_ORIGIN = "https://gate.naulon.app";
export const FLEET_DIRECTORY_URL = `${FLEET_ORIGIN}/directory`;

/** True only when discovery is the untouched fleet default — the ONLY case where the
 *  directory's own results may be auto-trusted as payable (see Task 2). A user who sets
 *  RSS_URL/PUBLISHER_URL or a custom CATALOG_URL is self-hosting and keeps the strict pin. */
export function isFleetDefaultDiscovery(cfg: { RSS_URL?: string; PUBLISHER_URL?: string; CATALOG_URL?: string }): boolean {
  return !cfg.RSS_URL && !cfg.PUBLISHER_URL && cfg.CATALOG_URL === FLEET_DIRECTORY_URL;
}
