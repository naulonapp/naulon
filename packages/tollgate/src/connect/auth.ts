/**
 * Who may call this gate's enforce API: a site credential issued by connect, or (for gates set up
 * before connect existed) the operator key and the per-site keys a platform publishes.
 *
 * A site credential acts for exactly one origin, the one its owner approved. The host a request
 * names must be that origin's host, port included, or the answer is the same 401 an unknown
 * credential gets, so a caller learns nothing about which sites this gate serves.
 */
import type { PublisherResolver } from "@naulon/shared";
import { isSiteCredential, resolveCredential, seenRecorder, type GateStateStore } from "@naulon/shared";
import type { EnforceAuth } from "../enforce-api/index.ts";
import { sharedKeyAuth } from "../enforce-api/sharedKeyAuth.ts";

const UNAUTHORIZED = { ok: false, status: 401, error: "unauthorized" } as const;

export function siteCredentialAuth(o: { state: GateStateStore; resolver: PublisherResolver; legacyKey?: string }): EnforceAuth {
  const legacy = o.legacyKey ? sharedKeyAuth(o.legacyKey, o.resolver) : null;
  // What the owner's Sites page reads as "last asked this gate". Recorded only for a request the
  // credential was allowed to make, so probing with a stolen credential on the wrong host does not
  // make a revoked-looking connection look alive.
  const seen = seenRecorder(o.state);
  return async (c, host) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!isSiteCredential(presented)) return legacy ? legacy(c, host) : UNAUTHORIZED;
    const record = await resolveCredential(o.state, presented);
    if (!record) return UNAUTHORIZED;
    const site = new URL(record.site).host;
    // enforce-status asks with no resource: the credential is valid, and it reports on its own site.
    if (host === null) {
      seen(presented);
      return { ok: true, publisherId: "", selfHosted: true };
    }
    if (host !== site) return UNAUTHORIZED;
    const publisher = await o.resolver.resolve(host);
    if (!publisher) return { ok: false, status: 403, error: "resource not owned by this key" };
    seen(presented);
    return { ok: true, publisherId: publisher.id, selfHosted: true };
  };
}
