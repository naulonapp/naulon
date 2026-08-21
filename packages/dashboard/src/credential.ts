/**
 * The ops console's credential, and the one property it was missing: the operator's
 * password is not stored in the clear.
 *
 * `DASHBOARD_AUTH` is `user:secret`, and it lands in `/opt/naulon/app/.env` on the box
 * (materialised from the deploy secret store), in a compose file, or in a shell's
 * history. HTTP Basic gives us no way to avoid SENDING the password, but nothing forced
 * us to STORE it — so the secret half may now be a scrypt PHC string, and the plaintext
 * form is deprecated rather than supported forever.
 *
 * scrypt, not argon2 or bcrypt, for one reason that outranks the others: this package has
 * four dependencies and none of them is native. A self-hoster's `npm install` must not
 * need a compiler, and the console ships a serverless entrypoint (api/index.ts) where a
 * native build is not an option at all. `node:crypto` has scrypt, it is memory-hard, and
 * it costs zero dependencies. Vaultwarden made the same move for the same reason (a plain
 * ADMIN_TOKEN, then an Argon2id PHC string); Prometheus stores bcrypt hashes in its web
 * config and supports several users that way. Neither invented a session to do it, and
 * neither needed to.
 *
 * THE COST THAT HAS TO BE PAID BACK: Basic sends the credential on EVERY request, and a
 * memory-hard hash is ~100 ms by design. One console page load is a burst of assets, API
 * calls and an SSE stream — twenty verifications, two seconds, all to re-answer a question
 * answered at the first one. So a verified credential is cached for a short TTL, keyed by
 * a per-process-salted digest of what the caller sent (never the password, and never a key
 * a different process could precompute). That cache is what makes hashing affordable under
 * a protocol that re-authenticates constantly; without it, hashing the credential would be
 * a self-inflicted latency bug and someone would rightly revert it.
 *
 * A wrong password is never cached, so the failed-sign-in budget in authThrottle.ts keeps
 * seeing every guess — the cache must never become the hole in the lockout.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** PHC id. `$scrypt$ln=15,r=8,p=1$<salt>$<hash>`, base64 without padding. */
const PHC_ID = "scrypt";
export const PHC_PREFIX = `$${PHC_ID}$`;

/** ~32 MB and ~100 ms on a 2020-era laptop. The interactive-login end of the scale. */
const DEFAULT_LN = 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/**
 * A ceiling on the work factor, because the parameters come from a config file. `ln=30`
 * is a typo that would otherwise ask node for a terabyte and hang the console at boot
 * with no explanation; refusing it names the problem instead.
 */
const MAX_LN = 20;

export interface ScryptParams {
  ln: number;
  r: number;
  p: number;
}

export interface ParsedPhc extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/** Node's maxmem must exceed 128 * N * r; give it headroom rather than tripping on equality. */
const maxmemFor = ({ ln, r }: ScryptParams) => 256 * 2 ** ln * r;

/** Mint a PHC string for a password. The `hash` script and first-run bootstrap both use this. */
export async function hashPassword(
  password: string,
  params: ScryptParams = { ln: DEFAULT_LN, r: DEFAULT_R, p: DEFAULT_P },
): Promise<string> {
  assertParams(params);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `${PHC_PREFIX}ln=${params.ln},r=${params.r},p=${params.p}$${b64(salt)}$${b64(key)}`;
}

function assertParams(params: ScryptParams): void {
  const { ln, r, p } = params;
  if (!Number.isInteger(ln) || ln < 1 || ln > MAX_LN) {
    throw new Error(`scrypt ln must be an integer in 1..${MAX_LN} (got ${ln})`);
  }
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error(`scrypt r must be an integer in 1..32 (got ${r})`);
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new Error(`scrypt p must be an integer in 1..16 (got ${p})`);
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scryptAsync(password, salt, KEYLEN, {
    N: 2 ** params.ln,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
}

/** Is this secret a stored hash rather than a password in the clear? */
export function isHashed(secret: string): boolean {
  return secret.startsWith(PHC_PREFIX);
}

/**
 * Parse a PHC string. Returns null rather than throwing on anything malformed: a
 * `DASHBOARD_AUTH` whose secret merely LOOKS like a hash must fail closed at verify
 * time, never fall back to comparing it as a plaintext password.
 */
export function parsePhc(secret: string): ParsedPhc | null {
  if (!isHashed(secret)) return null;
  const parts = secret.split("$");
  // ["", "scrypt", "ln=15,r=8,p=1", salt, hash]
  if (parts.length !== 5) return null;
  const [, id, paramStr, saltB64, hashB64] = parts;
  if (id !== PHC_ID || !paramStr || !saltB64 || !hashB64) return null;

  const params: Record<string, number> = {};
  for (const pair of paramStr.split(",")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined || !/^[0-9]+$/.test(v)) return null;
    params[k] = Number(v);
  }
  const ln = params["ln"];
  const r = params["r"];
  const p = params["p"];
  if (ln === undefined || r === undefined || p === undefined) return null;
  try {
    assertParams({ ln, r, p });
  } catch {
    return null;
  }

  const salt = Buffer.from(saltB64, "base64");
  const hash = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || hash.length !== KEYLEN) return null;
  return { ln, r, p, salt, hash };
}

/** Constant-time equality that tolerates different lengths (timingSafeEqual throws on those). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do the work, so a length mismatch is not a shorter code path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a supplied password against a stored secret, hashed or not.
 *
 * The plaintext branch is the behaviour that shipped, kept for one deprecation window:
 * `hono/basic-auth` compared hashes of both sides, and this keeps the equivalent
 * constant-time compare so replacing that dependency's compare is not a downgrade.
 */
export async function verifySecret(stored: string, supplied: string): Promise<boolean> {
  const phc = parsePhc(stored);
  if (!phc) {
    if (isHashed(stored)) return false; // looked like a hash, wasn't one: closed, never plaintext
    return safeEqual(stored, supplied);
  }
  const key = await derive(supplied, phc.salt, { ln: phc.ln, r: phc.r, p: phc.p });
  return key.length === phc.hash.length && timingSafeEqual(key, phc.hash);
}

export interface DashboardCredential {
  username: string;
  secret: string;
  /** False for a plaintext secret — the boot line warns on it. */
  hashed: boolean;
}

/**
 * Split `DASHBOARD_AUTH`. First colon only, so a password may contain colons; a PHC
 * string contains `$` and `,` but never `:`, so the same split holds for both forms.
 */
export function parseDashboardAuth(raw: string | undefined): DashboardCredential | null {
  if (!raw) return null;
  const [username, secret] = raw.split(/:(.*)/s);
  if (!username || secret === undefined || secret === "") return null;
  return { username, secret, hashed: isHashed(secret) };
}

/** Verified-credential cache. Small, short, and never holds a failure. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 32;

export interface VerifierOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Build the `verifyUser` hono's basicAuth takes. One credential today; the signature is
 * already (username, password) so a user STORE drops in here without touching server.ts.
 */
export function createCredentialVerifier(
  credential: DashboardCredential,
  opts: VerifierOptions = {},
): (username: string, password: string) => Promise<boolean> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Per-process, so a cache key is meaningless outside this process and cannot be
  // precomputed from a stolen hash.
  const pepper = randomBytes(16);
  const cache = new Map<string, number>();

  const keyFor = (username: string, password: string) =>
    createHash("sha256").update(pepper).update(username).update(" ").update(password).digest("base64");

  return async (username: string, password: string) => {
    const key = keyFor(username, password);
    const seen = cache.get(key);
    if (seen !== undefined && seen > now()) return true;
    if (seen !== undefined) cache.delete(key);

    // Both halves always run: a wrong username must not return faster than a wrong password.
    const userOk = safeEqual(credential.username, username);
    const secretOk = await verifySecret(credential.secret, password);
    if (!(userOk && secretOk)) return false;

    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, now() + ttl);
    return true;
  };
}
