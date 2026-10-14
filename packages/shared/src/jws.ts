/**
 * Compact JWS over Ed25519, shared by every token type this package signs.
 *
 * Each token type pins its own `typ`, so a token of one type can never verify as another: a
 * citation licence is `JWT`, a statement about a work is `naulon-statement+jwt`. Everything else
 * (the pinned algorithm, the refused header parameters, the key lookup, verifying over the literal
 * received bytes) lives here once, so two verifiers cannot drift apart.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { JwkSet, SigningKey } from "./license.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** JOSE header params that change how a token is interpreted. All refused. */
const FORBIDDEN_HEADER_PARAMS = ["crit", "jku", "x5u", "jwk", "x5c"];
const MAX_TOKEN_CHARS = 4096;

export function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signCompact(typ: string, payload: unknown, key: SigningKey): string {
  const header = { alg: "EdDSA", typ, kid: key.kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = sign(null, Buffer.from(signingInput, "ascii"), key.privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

export type CompactResult = { ok: true; payload: unknown } | { ok: false; error: string };

/**
 * Check a compact JWS of type `typ` against a key set and return its decoded payload. The
 * signature is checked over the literal received bytes before the payload is parsed. Claims are
 * the caller's to check.
 */
export function verifyCompact(jws: string, typ: string, jwks: JwkSet): CompactResult {
  const fail = (error: string): CompactResult => ({ ok: false, error });
  if (typeof jws !== "string" || jws.length === 0) return fail("empty token");
  if (jws.length > MAX_TOKEN_CHARS) return fail("token too large");

  const parts = jws.split(".");
  if (parts.length !== 3) return fail("malformed token (need 3 segments)");
  const [h, p, s] = parts as [string, string, string];
  if (!BASE64URL.test(h) || !BASE64URL.test(p) || !BASE64URL.test(s)) return fail("non-base64url segment");

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail("undecodable header");
  }
  // Pin the algorithm: never select the verify routine from the header. This rejects alg:"none"
  // and any HMAC (HS256-with-the-public-key) forgery.
  if (header.alg !== "EdDSA") return fail("unsupported alg (only EdDSA)");
  if (header.typ !== typ) return fail("unexpected typ");
  for (const param of FORBIDDEN_HEADER_PARAMS) {
    if (param in header) return fail(`forbidden header param: ${param}`);
  }
  const kid = header.kid;
  if (typeof kid !== "string") return fail("missing kid");

  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return fail("kid not in JWKS");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return fail("invalid JWKS key");
  }

  let valid = false;
  try {
    valid = verify(null, Buffer.from(`${h}.${p}`, "ascii"), publicKey, Buffer.from(s, "base64url"));
  } catch {
    return fail("verification error");
  }
  if (!valid) return fail("invalid signature");

  try {
    return { ok: true, payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as unknown };
  } catch {
    return fail("undecodable payload");
  }
}
