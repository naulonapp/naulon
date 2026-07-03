/**
 * Web Bot Auth — the SIGNING side of RFC 9421 HTTP Message Signatures, scoped
 * to the web-bot-auth profile the tollgate's verifier (tollgate/botAuth.ts)
 * enforces. This is the toll's own species signing its species marker: the
 * wayfarer stamps outbound requests with a verifiable identity, and the gate
 * serves (and self-signs) the key directory that identity points at.
 *
 * Lives in shared because both ends consume it — the wayfarer (sign requests)
 * and the tollgate (serve the directory) — and neither may depend on the other.
 * Self-contained on node:crypto, mirroring the verifier's zero-dep stance.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";

/** Where every Web Bot Auth key directory lives (the drafts' well-known path). */
export const BOT_AUTH_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const BOT_AUTH_DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";

/** Default request-signature validity. CF's operational profile recommends ~1
 *  minute; the draft caps acceptance at 24h. Short = small replay window. */
const DEFAULT_VALIDITY_SEC = 60;

/** A usable Ed25519 signing identity: the private key plus the public half in
 *  the two forms the protocol needs (raw JWK x, RFC 7638 thumbprint keyid). */
export interface BotAuthKey {
  privateKey: KeyObject;
  /** Base64url raw public key — the JWK `x` member the directory publishes. */
  x: string;
  /** RFC 7638 JWK thumbprint — the `keyid` every signature carries. */
  keyid: string;
}

/** RFC 7638 thumbprint of an Ed25519 public JWK: SHA-256 over the required
 *  members in lexicographic order (crv, kty, x). Byte-compatible with the
 *  verifier's jwkThumbprint — the round-trip test pins that. */
export function botAuthThumbprint(x: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))
    .digest("base64url");
}

/** PKCS#8 DER prefix for a raw Ed25519 32-byte seed (RFC 8410 structure with
 *  fixed lengths — the seed is always exactly 32 bytes). */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Materialize the signing identity from a base64url 32-byte Ed25519 seed (the
 * `BOT_AUTH_SIGNING_KEY` env). Throws on a malformed seed — the seed is
 * operator config, and config fails loud (AGENTS.md), never silently unsigned.
 */
export function botAuthKeyFromSeed(seedB64url: string): BotAuthKey {
  const seed = Buffer.from(seedB64url, "base64url");
  if (seed.length !== 32) {
    throw new Error(
      `BOT_AUTH_SIGNING_KEY must be a base64url 32-byte Ed25519 seed (got ${seed.length} bytes) — generate one with scripts/wba-keygen.mjs`,
    );
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("failed to derive the Ed25519 public key from the seed");
  return { privateKey, x: jwk.x, keyid: botAuthThumbprint(jwk.x) };
}

/** The three headers a signing agent attaches (lowercase names, ready to merge
 *  into a fetch). `signature-agent` is present only for the request profile —
 *  a directory response identifies itself by being AT the well-known URL. */
export interface BotAuthSignedHeaders {
  "signature-input": string;
  signature: string;
  "signature-agent"?: string;
}

interface SignParams {
  key: BotAuthKey;
  /** The `@authority` the signature covers — the host:port the request targets. */
  authority: string;
  tag: "web-bot-auth" | "http-message-signatures-directory";
  /** Signature-Agent value (request profile only): the directory host, e.g.
   *  "naulon.app", or an http://127.0.0.1:port fixture under the gate's
   *  BOT_AUTH_ALLOW_HTTP test flag. */
  agent?: string;
  createdSec?: number;
  validitySec?: number;
  label?: string;
}

/**
 * Build + sign the RFC 9421 headers for one request (or directory response).
 * Covered components: `("@authority")` — the CF operational profile's minimum,
 * which is also what deployed signers (chatgpt.com) cover. The signature base
 * reuses the exact Signature-Input member text, so signer and verifier agree
 * byte-for-byte by construction.
 */
export function signBotAuth(params: SignParams): BotAuthSignedHeaders {
  const created = params.createdSec ?? Math.floor(Date.now() / 1000);
  const expires = created + (params.validitySec ?? DEFAULT_VALIDITY_SEC);
  const label = params.label ?? "sig1";
  const member = `("@authority");created=${created};expires=${expires};keyid="${params.key.keyid}";tag="${params.tag}"`;
  const base = `"@authority": ${params.authority.toLowerCase()}\n"@signature-params": ${member}`;
  const sig = cryptoSign(null, Buffer.from(base, "utf8"), params.key.privateKey).toString("base64");
  const headers: BotAuthSignedHeaders = {
    "signature-input": `${label}=${member}`,
    signature: `${label}=:${sig}:`,
  };
  // CF profile: Signature-Agent MUST be a plain quoted string (rev-00's
  // dictionary form is rejected by deployed verifiers).
  if (params.agent !== undefined) headers["signature-agent"] = `"${params.agent}"`;
  return headers;
}

/** The directory body: a JWKS of our Ed25519 key(s). Minimal by design — the
 *  verifier reads kty/crv/x and ignores everything else. */
export function botAuthDirectoryBody(key: BotAuthKey): string {
  return JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: key.x }] });
}

/**
 * Sign a directory RESPONSE (tag="http-message-signatures-directory") — the
 * spec's binding of the published keys to the serving host. `authority` is the
 * Host the client dialed; a verifier rebuilds the base from the URL it fetched.
 */
export function signBotAuthDirectory(key: BotAuthKey, authority: string, createdSec?: number): BotAuthSignedHeaders {
  const params: SignParams = { key, authority, tag: "http-message-signatures-directory", validitySec: 300 };
  if (createdSec !== undefined) params.createdSec = createdSec;
  return signBotAuth(params);
}
