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
 * memory-hard hash is ~350 ms at the parameters below, by design. One console page load is a burst of assets, API
 * calls and an SSE stream — twenty verifications, seven seconds, all to re-answer a question
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

/** PHC id. `$scrypt$ln=16,r=8,p=2$<salt>$<hash>`, base64 without padding. */
const PHC_ID = "scrypt";
export const PHC_PREFIX = `$${PHC_ID}$`;

/**
 * OWASP's Password Storage Cheat Sheet (read 2026-08-21) gives scrypt as a ladder of
 * equivalent-defence rows, not a single number:
 *
 *   N=2^17 (128 MiB), r=8, p=1   ← the headline recommendation
 *   N=2^16  (64 MiB), r=8, p=2   ← this
 *   N=2^15  (32 MiB), r=8, p=3
 *   N=2^14  (16 MiB), r=8, p=5
 *   N=2^13   (8 MiB), r=8, p=10
 *
 * The `p` column is the part that is easy to get wrong: dropping N without raising p is
 * not "the same hash, cheaper", it is a weaker hash. This shipped at N=2^15,r=8,p=1 for
 * exactly one commit, which was off that ladder entirely.
 *
 * 2^16 rather than 2^17 because of where this runs. The console is self-hosted, often on
 * a 1 GB VPS beside the gate, and the failed-sign-in budget below permits a burst of ten
 * guesses — ten concurrent 128 MiB derivations is 1.3 GB of resident memory and an OOM
 * kill of the gate, i.e. the password hash becoming the outage. 64 MiB with the
 * concurrency cap below peaks at 128 MiB whatever an attacker does.
 */
const DEFAULT_LN = 16;
const DEFAULT_R = 8;
const DEFAULT_P = 2;
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

export const DEFAULT_PARAMS: ScryptParams = { ln: DEFAULT_LN, r: DEFAULT_R, p: DEFAULT_P };

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/** Node's maxmem must exceed 128 * N * r; give it headroom rather than tripping on equality. */
const maxmemFor = ({ ln, r }: ScryptParams) => 256 * 2 ** ln * r;

/** Mint a PHC string for a password. The `hash` script and first-run bootstrap both use this. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
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

/**
 * A memory-hard hash is a memory-exhaustion primitive pointed at yourself: the whole
 * design is "this costs 64 MiB", and nothing stops ten requests from arriving together.
 * The failed-sign-in budget rate-limits guesses, but it is a budget PER CLIENT and it
 * charges only after the 401 — the derivations are already in flight by then.
 *
 * So derivations are serialised two at a time. An attacker's flood queues instead of
 * allocating, a real operator never notices (their credential is cached after the first
 * request), and the console's peak from this path is bounded at 2 x 64 MiB regardless of
 * load. Queueing is the right failure here — the alternative is an OOM kill that takes
 * the GATE down with the console.
 */
const MAX_CONCURRENT_DERIVES = 2;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_DERIVES) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
}

function release(): void {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Node hashes the password into scrypt's PBKDF2 stage, so length barely affects cost —
 * but an unbounded body still gets copied and held, and there is no reason a console
 * password is a megabyte. OWASP's guidance to cap input length applies for that reason
 * rather than bcrypt's 72-byte truncation, which scrypt does not have.
 */
const MAX_PASSWORD_BYTES = 1024;

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`password exceeds ${MAX_PASSWORD_BYTES} bytes`);
  }
  await acquire();
  try {
    return await deriveNow(password, salt, params);
  } finally {
    release();
  }
}

function deriveNow(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
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
  if (Buffer.byteLength(supplied, "utf8") > MAX_PASSWORD_BYTES) return false; // a caller's input, not a bug
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
