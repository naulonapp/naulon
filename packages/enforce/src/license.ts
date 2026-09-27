/**
 * Tollgate licensing boot. Resolves the Citation License signing key once at
 * startup (a stable key from config, or — only on the single-instance mock path —
 * an ephemeral one with a warning) and exposes the JWK Set the gate publishes at
 * /.well-known/naulon-jwks.json. `null` when LICENSES_ENABLED=false.
 *
 * Minting + the re-read entitlement (which use `licensing.key`) land in P2; P1
 * publishes the public key so verifiers can be wired up first.
 */
import { getConfig, jwksOf, loadSigningKey, retiredJwks, type JwkSet, type SigningKey } from "@naulon/shared";

const cfg = getConfig();

export interface Licensing {
  key: SigningKey;
  /** The LIVE key only. What a re-read is verified against. */
  jwks: JwkSet;
  /** The live key plus every retired one: what the gate publishes, so old records keep verifying. */
  publishedJwks: JwkSet;
}

export const licensing: Licensing | null = cfg.LICENSES_ENABLED
  ? (() => {
      const key = loadSigningKey(cfg.LICENSE_SIGNING_KEY);
      const jwks = jwksOf([key]);
      const retired = retiredJwks(cfg.LICENSE_RETIRED_PUBLIC_KEYS).filter((k) => k.kid !== key.kid);
      return { key, jwks, publishedJwks: { keys: [...jwks.keys, ...retired] } };
    })()
  : null;
