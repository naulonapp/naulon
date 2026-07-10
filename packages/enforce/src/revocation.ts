/**
 * License revocation seam (the v1 kill switch for a leaked token before its exp).
 *
 * A CLT is a bearer entitlement, so the only defence against a captured-but-
 * unexpired token — beyond the short TTL — is denying its `jti`. This is enforced
 * ONLY on the trusted tiers: the gate's own re-read path and `GET /licenses/:jti`
 * (when LICENSE_ONLINE_CHECK is on). The offline JWKS tier can't consult it by
 * design; that residual window is bounded by the TTL (see docs/citation-license.md).
 *
 * Backend mirrors the event/nonce stores: an in-process Set by default, or a
 * shared Supabase table (`jti` primary key) when a supabase backend is in play so
 * revocations hold across instances.
 */
import { getConfig, supabaseRest } from "@naulon/shared";

const cfg = getConfig();

export interface RevocationStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<void>;
}

function memoryRevocation(): RevocationStore {
  const revoked = new Set<string>();
  return {
    async isRevoked(jti) {
      return revoked.has(jti);
    },
    async revoke(jti) {
      revoked.add(jti);
    },
  };
}

function supabaseRevocation(): RevocationStore {
  const table = cfg.SUPABASE_REVOCATIONS_TABLE;
  return {
    async isRevoked(jti) {
      const rows = (await supabaseRest(
        `/rest/v1/${table}?jti=eq.${encodeURIComponent(jti)}&select=jti&limit=1`,
      )) as unknown[];
      return rows.length > 0;
    },
    async revoke(jti) {
      await supabaseRest(`/rest/v1/${table}?on_conflict=jti`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify([{ jti }]),
      });
    },
  };
}

const usesSupabase = cfg.EVENTS_BACKEND === "supabase" || cfg.NONCE_BACKEND === "supabase";
export const revocations: RevocationStore = usesSupabase ? supabaseRevocation() : memoryRevocation();
