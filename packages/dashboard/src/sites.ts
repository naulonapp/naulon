/**
 * The Sites page's server half: every site connected to this gate, the credentials connect issued
 * for it, and the one write an owner needs, revoking one.
 *
 * The page never receives a credential. It gets each record's id (the credential's SHA-256, which
 * is what the store is keyed by) and the last four characters, which is enough to tell two apart
 * and to match one against the copy a site holds.
 */
import { listCredentials, revokeCredentialById, SEEN_EVERY_MS, type GateStateStore, type ListedCredential } from "@naulon/shared";

export interface SiteConnection {
  id: string;
  clientName: string;
  clientId: string;
  approvedBy: string;
  createdAt: number;
  hint: string;
  lastSeenAt: number | null;
}

export interface ConnectedSite {
  /** The origin the owner approved, e.g. `https://blog.example.com`. */
  site: string;
  host: string;
  connections: SiteConnection[];
}

export interface SitesView {
  sites: ConnectedSite[];
  /** True when NAULON_ENFORCE_KEY is set: a key that tolls for any site, outside this list. */
  legacyKey: boolean;
  /** How fresh `lastSeenAt` is, so the page can say "within the hour" instead of a false second. */
  seenEveryMs: number;
}

const connectionOf = (c: ListedCredential): SiteConnection => ({
  id: c.id,
  clientName: c.clientName,
  clientId: c.clientId,
  approvedBy: c.approvedBy,
  createdAt: c.createdAt,
  hint: c.hint,
  lastSeenAt: c.lastSeenAt,
});

/** Grouped by site, sites by host, and within a site the newest connection first. */
export async function buildSitesView(state: GateStateStore, o: { legacyKey: boolean }): Promise<SitesView> {
  const bySite = new Map<string, SiteConnection[]>();
  for (const c of await listCredentials(state)) {
    const list = bySite.get(c.site) ?? [];
    list.push(connectionOf(c));
    bySite.set(c.site, list);
  }
  const sites = [...bySite]
    .map(([site, connections]) => ({ site, host: new URL(site).host, connections: connections.sort((a, b) => b.createdAt - a.createdAt) }))
    .sort((a, b) => a.host.localeCompare(b.host));
  return { sites, legacyKey: o.legacyKey, seenEveryMs: SEEN_EVERY_MS };
}

export type RevokeResult = { ok: true; site: string; clientName: string } | { ok: false; error: string };

/** Revoke by id. Reports what was revoked so the audit line and the page can name it. */
export async function revokeConnection(state: GateStateStore, id: unknown): Promise<RevokeResult> {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return { ok: false, error: "That is not a connection id." };
  const held = await revokeCredentialById(state, id);
  if (!held) return { ok: false, error: "That connection is already gone. Reload to see what is left." };
  return { ok: true, site: held.site, clientName: held.clientName };
}
