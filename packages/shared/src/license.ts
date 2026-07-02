/**
 * Citation License Token (CLT) — sign + verify. See docs/citation-license.md.
 *
 * A CLT is a signed, independently verifiable receipt the tollgate hands an agent
 * when it pays: proof of who paid, how much USDC, for which essay, to which
 * author wallet(s), settled on-chain. It is a signed projection of the
 * AttributedEvent already recorded per payment (jti = event.id). Re-presenting a
 * valid unexpired CLT re-reads that essay free within a short window — so the toll
 * becomes an asset the payer wants, not a tax it evades.
 *
 * Format: a strict RFC 7519 JWT, EdDSA-signed (Ed25519, node:crypto — no dep),
 * verifiable by an unmodified jose/pyjwt client. Domain data lives under one
 * namespaced `naulon` claim so it never shadows a registered JWT claim.
 *
 * SECURITY — two invariants this module enforces (a regression in either is a
 * free-read bypass; see the adversarial tests in license.test.ts):
 *   1. verify IGNORES the token's `alg` header and hard-pins Ed25519. The public
 *      key is world-readable at the JWKS endpoint, so trusting `alg` would allow
 *      alg:none and HMAC-with-the-public-key forgery. The verify routine is fixed
 *      to crypto.verify over the LITERAL received bytes; claims are parsed only
 *      AFTER the signature passes.
 *   2. mint/verify are PURE and take an explicit `now` (no ambient clock in
 *      shared). mint reads only in-memory event fields — never the EventSink — so
 *      a record() failure after settle still yields a valid receipt.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { toAtomicUsdc } from "./networks.ts";
import { primaryPayee, type TieBreak } from "./attribution.ts";
import type { AttributedEvent, AuthorShare } from "./types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

/** A JSON Web Key for an Ed25519 public key (OKP). */
export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
}
export interface JwkSet {
  keys: Jwk[];
}

/** A resolved signing key: the private key, its public key, and a stable kid. */
export interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

/** The namespaced `naulon` claim — the domain payload. */
export interface NaulonClaim {
  v: 1;
  slug: string;
  title: string;
  kind: AttributedEvent["kind"];
  /** Integer micro-USDC as a string (e.g. "1000" = $0.001) — never a float. */
  amount: string;
  currency: "USDC";
  network: { chainId: number; usdc: string; gateway: string };
  settlementRef: string;
  /** Present in "full" payees mode. */
  payees?: AuthorShare[];
  /** Present in "hashed" payees mode. */
  payeesHash?: string;
  payTo?: string;
}

/**
 * RFC 7800 confirmation claim. When present, the license is HOLDER-OF-KEY bound:
 * a re-read must prove possession of the named wallet's key (an EIP-191 signature
 * over a fresh challenge), so capturing the bearer token alone is not enough.
 * `naulon:addr` is the lowercased payer wallet that must sign the proof.
 */
export interface ConfirmationClaim {
  "naulon:addr": string;
}

/** The full CLT claim set (registered JWT claims + the `naulon` object). */
export interface CitationLicenseClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  naulon: NaulonClaim;
  /** Present only on holder-of-key licenses (LICENSE_POP). RFC 7800. */
  cnf?: ConfirmationClaim;
}

export interface MintInput {
  event: AttributedEvent;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  payeesMode: "full" | "hashed";
  title: string;
  network: { chainId: number; usdc: string; gateway: string };
  /**
   * Tie-break for the hashed-mode `payTo` (the advertised primary recipient).
   * MUST match the gate's `PRIMARY_PAYEE_TIEBREAK` so the license names exactly
   * the wallet the on-chain leg paid and the settlement record flags `primary`.
   * Defaults to `"wallet"` (the shared default). Unused in `full` payees mode.
   */
  tieBreak?: TieBreak;
  /**
   * When set, mint a HOLDER-OF-KEY license bound to this wallet (the payer): a
   * re-read must present a proof-of-possession signed by it. Omit for a v1 bearer
   * license. Must be a real address — never the zero-address fallback.
   */
  popBindAddress?: string;
}

export type VerifyResult =
  | { ok: true; claims: CitationLicenseClaims }
  | { ok: false; error: string };

// ── Key handling ──────────────────────────────────────────────────────────────

/** Raw 32-byte Ed25519 public key bytes (from the OKP `x` parameter). */
function rawPublicKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 (OKP) public key");
  return Buffer.from(jwk.x, "base64url");
}

/** Stable key id = base64url(SHA-256(raw public key))[:16]. */
export function kidFor(publicKey: KeyObject): string {
  return createHash("sha256").update(rawPublicKey(publicKey)).digest("base64url").slice(0, 16);
}

/** The public JWK for a signing key. */
export function publicJwk(key: SigningKey): Jwk {
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: rawPublicKey(key.publicKey).toString("base64url"),
    kid: key.kid,
    use: "sig",
    alg: "EdDSA",
  };
}

/** A JWK Set advertising every supplied key (publish at the JWKS endpoint). */
export function jwksOf(keys: SigningKey[]): JwkSet {
  return { keys: keys.map(publicJwk) };
}

/**
 * Resolve the signing key from a config secret, or generate an EPHEMERAL one.
 *
 * `secret` may be a PKCS8 PEM or base64-encoded PKCS8 DER Ed25519 private key.
 * If absent, an ephemeral key is generated with a loud warning — acceptable ONLY
 * for single-instance mock/dev; config.ts fails loud when a stable key is
 * required (real money or a supabase/multi-instance backend).
 */
export function loadSigningKey(secret?: string): SigningKey {
  let privateKey: KeyObject;
  if (secret && secret.trim()) {
    privateKey = parsePrivateKey(secret.trim());
  } else {
    console.warn(
      "[license] LICENSE_SIGNING_KEY not set — generating an EPHEMERAL Ed25519 key. " +
        "Valid only for single-instance mock/dev: outstanding licenses break on restart and " +
        "across instances. Set LICENSE_SIGNING_KEY for any real or multi-instance deploy.",
    );
    privateKey = generateKeyPairSync("ed25519").privateKey;
  }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("LICENSE_SIGNING_KEY must be an Ed25519 private key");
  }
  return { privateKey, publicKey, kid: kidFor(publicKey) };
}

function parsePrivateKey(secret: string): KeyObject {
  if (secret.includes("BEGIN")) return createPrivateKey(secret);
  return createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" });
}

// ── Mint ──────────────────────────────────────────────────────────────────────

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Deterministic canonical JSON of payees (sorted, fixed field order) for hashing. */
function canonicalPayees(payees: AuthorShare[]): string {
  const sorted = [...payees].sort(
    (a, b) => a.authorId.localeCompare(b.authorId) || a.wallet.localeCompare(b.wallet),
  );
  return JSON.stringify(
    sorted.map((p) => [p.authorId, p.wallet, p.share]),
  );
}

/**
 * Mint a compact-JWS CLT from a settled event. Pure: takes an explicit `now` and
 * reads only the in-memory event — never the EventSink.
 */
export function mintLicense(input: MintInput, key: SigningKey, now: number): string {
  const { event } = input;
  const iat = Math.floor(now / 1000);

  const naulon: NaulonClaim = {
    v: 1,
    slug: event.slug,
    title: input.title,
    kind: event.kind,
    amount: toAtomicUsdc(event.amount),
    currency: "USDC",
    network: input.network,
    settlementRef: event.settlementRef,
  };
  if (input.payeesMode === "hashed") {
    naulon.payeesHash = createHash("sha256").update(canonicalPayees(event.payees)).digest("base64url");
    naulon.payTo = primaryPayee(event.payees, input.tieBreak);
  } else {
    naulon.payees = event.payees.map((p) => ({ authorId: p.authorId, wallet: p.wallet, share: p.share }));
  }

  const payload: CitationLicenseClaims = {
    iss: input.issuer,
    aud: input.audience,
    sub: event.payerAddress,
    jti: event.id,
    iat,
    nbf: iat,
    exp: iat + input.ttlSeconds,
    naulon,
  };
  // Holder-of-key: bind the license to the payer wallet so a re-read needs a
  // proof-of-possession, not just the token. Lowercased for a canonical compare.
  if (input.popBindAddress) {
    payload.cnf = { "naulon:addr": input.popBindAddress.toLowerCase() };
  }

  const header = { alg: "EdDSA", typ: "JWT", kid: key.kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = sign(null, Buffer.from(signingInput, "ascii"), key.privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

// ── Verify ──────────────────────────────────────────────────────────────────

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// JOSE header params that change how a token is interpreted — reject them all.
const FORBIDDEN_HEADER_PARAMS = ["crit", "jku", "x5u", "jwk", "x5c"];
/** Negative clock-skew tolerance (seconds) on nbf/iat only. */
const SKEW_SECONDS = 60;

function fail(error: string): VerifyResult {
  return { ok: false, error };
}

/**
 * Verify a CLT against a JWK Set, issuer, audience and clock. Fails closed on any
 * defect. The algorithm is pinned to Ed25519 regardless of the token header, and
 * the signature is checked over the literal received bytes before any claim is
 * read. `now` is epoch ms (the caller's clock); claims are epoch seconds.
 */
export function verifyLicense(
  jws: string,
  opts: { now: number; expectedIssuer: string; expectedAudience: string; jwks: JwkSet },
): VerifyResult {
  if (typeof jws !== "string" || jws.length === 0) return fail("empty token");
  if (jws.length > 4096) return fail("token too large");

  const parts = jws.split(".");
  if (parts.length !== 3) return fail("malformed token (need 3 segments)");
  const [h, p, s] = parts as [string, string, string];
  if (!BASE64URL.test(h) || !BASE64URL.test(p) || !BASE64URL.test(s)) {
    return fail("non-base64url segment");
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail("undecodable header");
  }
  // Pin the algorithm — never select the verify routine from the header. This
  // rejects alg:"none" and any HMAC (HS256-with-the-public-key) forgery.
  if (header.alg !== "EdDSA") return fail("unsupported alg (only EdDSA)");
  if (header.typ !== "JWT") return fail("unexpected typ");
  for (const param of FORBIDDEN_HEADER_PARAMS) {
    if (param in header) return fail(`forbidden header param: ${param}`);
  }
  const kid = header.kid;
  if (typeof kid !== "string") return fail("missing kid");

  const jwk = opts.jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return fail("kid not in JWKS");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return fail("invalid JWKS key");
  }

  // Verify over the LITERAL received bytes — not a re-serialized payload.
  const sigBytes = Buffer.from(s, "base64url");
  let valid = false;
  try {
    valid = verify(null, Buffer.from(`${h}.${p}`, "ascii"), publicKey, sigBytes);
  } catch {
    return fail("verification error");
  }
  if (!valid) return fail("invalid signature");

  // Only now is it safe to read claims.
  let claims: CitationLicenseClaims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as CitationLicenseClaims;
  } catch {
    return fail("undecodable payload");
  }

  if (claims.iss !== opts.expectedIssuer) return fail("issuer mismatch");
  if (claims.aud !== opts.expectedAudience) return fail("audience mismatch");

  const nowSec = Math.floor(opts.now / 1000);
  if (!Number.isFinite(claims.exp) || nowSec >= claims.exp) return fail("expired");
  if (Number.isFinite(claims.nbf) && nowSec < claims.nbf - SKEW_SECONDS) return fail("not yet valid");
  if (Number.isFinite(claims.iat) && claims.iat > nowSec + SKEW_SECONDS) return fail("issued in the future");

  return { ok: true, claims };
}

// ── Holder-of-key proof-of-possession (P5) ───────────────────────────────────

/** The wallet a holder-of-key license is bound to, or null for a v1 bearer license. */
export function popBoundAddress(claims: CitationLicenseClaims): string | null {
  const addr = claims.cnf?.["naulon:addr"];
  return typeof addr === "string" && addr ? addr.toLowerCase() : null;
}

/** The fields a proof-of-possession is bound to. */
export interface PopChallenge {
  /** The gate's identity (= license aud); pins the proof to one deployment. */
  aud: string;
  /** The license id; pins the proof to one license. */
  jti: string;
  /** The essay slug; pins the proof to one article (defense in depth over jti). */
  slug: string;
  /** Unix seconds the proof was created; the gate enforces a freshness window. */
  ts: number;
  /** Single-use random salt; the gate spends it once to stop replay in-window. */
  nonce: string;
}

/**
 * The canonical bytes a holder signs (EIP-191 personal_sign) and the gate
 * reconstructs to recover the signer. Pure and deterministic — no clock, no
 * crypto here, just a fixed-order newline framing so signer and verifier agree
 * byte-for-byte. Reject any `\n` in inputs would be belt-and-braces; jti/nonce
 * are hex, aud/slug are controlled, so the framing is unambiguous in practice.
 */
export function popMessage(c: PopChallenge): string {
  return [
    "naulon-pop",
    "v=1",
    `aud=${c.aud}`,
    `jti=${c.jti}`,
    `slug=${c.slug}`,
    `ts=${c.ts}`,
    `nonce=${c.nonce}`,
  ].join("\n");
}
