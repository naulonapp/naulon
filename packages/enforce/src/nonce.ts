/**
 * Payment nonces — replay protection for the x402 handshake.
 *
 * Without this, a captured `payment-signature` could be replayed forever to read
 * for free (mock mode has no chain to stop it; even live, defence-in-depth is
 * cheap). Each 402 carries a fresh nonce the agent must echo in its payment.
 *
 * Design: issuance is STATELESS — the nonce is its own proof. It's
 *   `${expMs}.${rand}.${hmac}`
 * where the HMAC is taken over the expiry, the random salt, AND the payment
 * binding (amount + payTo + network). Two consequences:
 *   - a nonce minted for a $0.001 read can't be reused to satisfy a $0.005
 *     citation — the binding wouldn't match.
 *   - the gate needs no memory of what it issued to validate a nonce later.
 *
 * The only state is a CONSUMED set so a valid nonce works exactly once. It lives
 * behind the `ConsumedStore` seam below: an in-process Map by default (single
 * instance), or a shared Supabase table when NONCE_BACKEND=supabase — which is
 * what makes the gate safe to run as many serverless instances (Vercel). For
 * either multi-instance path, also set TOLLGATE_SECRET so every instance signs
 * and verifies nonces with the same key.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig, supabaseRest } from "@naulon/shared";

const cfg = getConfig();

const secret =
  cfg.TOLLGATE_SECRET ??
  (() => {
    const ephemeral = randomBytes(32).toString("hex");
    console.warn(
      "[tollgate] TOLLGATE_SECRET not set — using an ephemeral nonce secret. " +
        "Outstanding 402s are invalidated on restart; set TOLLGATE_SECRET for stability/multi-instance.",
    );
    return ephemeral;
  })();

const ttlMs = cfg.NONCE_TTL_SECONDS * 1000;

/** The payment facts a nonce is cryptographically bound to. */
export interface NonceBinding {
  amount: string;
  payTo: string;
  network: string;
}

function sign(expMs: number, rand: string, b: NonceBinding): string {
  return createHmac("sha256", secret)
    .update(`${expMs}.${rand}.${b.amount}.${b.payTo}.${b.network}`)
    .digest("hex");
}

/** Mint a nonce bound to a payment requirement, valid for NONCE_TTL_SECONDS. */
export function issueNonce(binding: NonceBinding, now: number): string {
  const expMs = now + ttlMs;
  const rand = randomBytes(12).toString("hex");
  return `${expMs}.${rand}.${sign(expMs, rand, binding)}`;
}

/**
 * The "has this nonce been spent?" store — the one piece of nonce state that
 * isn't carried inside the nonce itself. Issuance is stateless (the HMAC is the
 * proof); only single-use enforcement needs memory. Behind this seam it can be
 * an in-process Map (default) or a shared table (Supabase) so the guarantee
 * survives across serverless instances.
 */
export interface ConsumedStore {
  /**
   * Atomically mark `nonce` as spent. Resolve `true` if this call was the first
   * to spend it, `false` if it was already spent (a replay). Must be a single
   * atomic step — a check-then-set with a gap would let two concurrent replays
   * both win.
   */
  consume(nonce: string, expMs: number, now: number): Promise<boolean>;
}

/** Default store: an in-process Map. Correct for a single instance. */
function memoryStore(): ConsumedStore {
  // nonce -> expiry ms. A present key means "already spent".
  const consumed = new Map<string, number>();
  const sweep = (now: number): void => {
    for (const [n, exp] of consumed) if (exp <= now) consumed.delete(n);
  };
  return {
    async consume(nonce, expMs, now) {
      if (consumed.has(nonce)) return false;
      if (consumed.size > 10_000) sweep(now); // amortized cleanup under load
      consumed.set(nonce, expMs);
      return true;
    },
  };
}

/**
 * Shared store: a Supabase table with `nonce` as the primary key. The DB is the
 * arbiter of single-use — we INSERT and let the unique constraint decide. With
 * `resolution=ignore-duplicates` a conflicting insert is silently dropped and,
 * thanks to `return=representation`, the response is an EMPTY array — so "a row
 * came back" means we won the insert (fresh), and "[]" means someone already
 * spent it (replay). One round-trip, atomic, race-safe across instances.
 */
function supabaseStore(): ConsumedStore {
  const table = getConfig().SUPABASE_NONCES_TABLE;
  return {
    async consume(nonce, expMs) {
      const rows = (await supabaseRest(`/rest/v1/${table}?on_conflict=nonce`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{ nonce, exp_ms: expMs }]),
      })) as unknown[];
      return rows.length > 0;
    },
  };
}

/**
 * Build a single-use store using the configured backend. Each caller gets its
 * own instance — the memory backend is a private Map, and the Supabase backend
 * shares the nonces table but callers namespace their keys (e.g. the PoP path
 * prefixes `pop:`) so distinct uses never collide. Reused by the holder-of-key
 * proof verifier (pop.ts) so its replay protection inherits the same seam.
 */
export function makeConsumedStore(): ConsumedStore {
  return cfg.NONCE_BACKEND === "supabase" ? supabaseStore() : memoryStore();
}

const store: ConsumedStore = makeConsumedStore();

export type ConsumeResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a nonce against a payment binding and spend it. Fails closed on a
 * bad shape, a forged/mismatched HMAC, expiry, or replay. The signature/expiry
 * checks run before we touch the store, so a forged nonce never hits the DB.
 */
export async function consumeNonce(
  nonce: string,
  binding: NonceBinding,
  now: number,
): Promise<ConsumeResult> {
  const parts = nonce.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed nonce" };
  const [expStr, rand, mac] = parts as [string, string, string];

  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) return { ok: false, error: "malformed nonce" };
  if (expMs <= now) return { ok: false, error: "nonce expired" };

  const expected = sign(expMs, rand, binding);
  // Constant-time compare; lengths match (both hex SHA-256) so this is safe.
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return { ok: false, error: "invalid nonce signature" };
  }

  if (!(await store.consume(nonce, expMs, now))) {
    return { ok: false, error: "nonce already used (replay)" };
  }
  return { ok: true };
}
