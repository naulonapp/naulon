/**
 * Tollgate licensing boot. Resolves the Citation License signing key once at
 * startup (a stable key from config, or — only on the single-instance mock path —
 * an ephemeral one with a warning) and exposes the JWK Set the gate publishes at
 * /.well-known/naulon-jwks.json. `null` when LICENSES_ENABLED=false.
 *
 * Minting + the re-read entitlement (which use `licensing.key`) land in P2; P1
 * publishes the public key so verifiers can be wired up first.
 */
import { getConfig, jwksOf, loadSigningKey, type JwkSet, type SigningKey } from "@naulon/shared";

const cfg = getConfig();

export interface Licensing {
  key: SigningKey;
  jwks: JwkSet;
}

export const licensing: Licensing | null = cfg.LICENSES_ENABLED
  ? (() => {
      const key = loadSigningKey(cfg.LICENSE_SIGNING_KEY);
      return { key, jwks: jwksOf([key]) };
    })()
  : null;
