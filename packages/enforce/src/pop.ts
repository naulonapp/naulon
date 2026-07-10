/**
 * Holder-of-key proof-of-possession (P5). See docs/citation-license.md.
 *
 * A holder-of-key license carries a `cnf` claim binding it to the payer wallet.
 * Re-reading it free is no longer a bearer right: the caller must prove it holds
 * that wallet's key by signing a fresh challenge (EIP-191 personal_sign). So a
 * captured `X-Naulon-License` header is worthless without the private key.
 *
 * The proof rides in `X-Naulon-Proof: <ts>.<nonce>.<sig>` where the agent signed
 * `popMessage({ aud, jti, slug, ts, nonce })`. The gate reconstructs that exact
 * message from the (already signature-verified) license claims plus the proof's
 * own ts/nonce, recovers the signer with viem, and accepts iff:
 *   - the recovered address equals the wallet named in `cnf` (constant-compare
 *     by lowercased hex),
 *   - `ts` is within ±LICENSE_POP_WINDOW_SECONDS of the gate clock (freshness),
 *   - the (jti, nonce) pair has not been spent — single-use via the same
 *     ConsumedStore seam the 402 nonces use, so replay is closed in-window too.
 *
 * Fails CLOSED: any defect returns false, which drops the caller to the normal
 * 402 path (pay again) — never a 500, never a free pass.
 */
import { recoverMessageAddress } from "viem";
import { getConfig, popBoundAddress, popMessage, type CitationLicenseClaims } from "@naulon/shared";
import { makeConsumedStore } from "./nonce.ts";

const cfg = getConfig();
const windowSec = cfg.LICENSE_POP_WINDOW_SECONDS;

// Single-use store for proof nonces. Keys are namespaced `pop:<jti>:<nonce>` so
// they never collide with the 402 payment nonces in a shared Supabase table.
const proofStore = makeConsumedStore();

/** Hard cap on the proof header before any parsing (an EIP-191 sig is ~132 chars). */
const MAX_PROOF_LEN = 1024;
const HEX_NONCE = /^[0-9a-f]{8,64}$/;
const ETH_SIG = /^0x[0-9a-fA-F]{130}$/;

export interface PopContext {
  claims: CitationLicenseClaims;
  slug: string;
  /** The gate identity (= license aud); pins the proof to this deployment. */
  identity: string;
  /** Epoch ms (the gate clock). */
  now: number;
}

/**
 * Verify a proof-of-possession header for a holder-of-key license. Returns true
 * only if the proof is fresh, single-use, and signed by the bound wallet.
 */
export async function verifyPopProof(proofHeader: string, ctx: PopContext): Promise<boolean> {
  try {
    if (typeof proofHeader !== "string" || proofHeader.length === 0 || proofHeader.length > MAX_PROOF_LEN) {
      return false;
    }
    const bound = popBoundAddress(ctx.claims);
    if (!bound) return false; // caller should only invoke this for cnf-bound licenses

    const parts = proofHeader.split(".");
    if (parts.length !== 3) return false;
    const [tsStr, nonce, sig] = parts as [string, string, string];

    if (!HEX_NONCE.test(nonce) || !ETH_SIG.test(sig)) return false;
    const ts = Number(tsStr);
    if (!Number.isInteger(ts)) return false;

    // Freshness: the proof's self-asserted timestamp must sit within the window
    // of the gate clock, in BOTH directions (stale replay and future-dating).
    const nowSec = Math.floor(ctx.now / 1000);
    if (Math.abs(nowSec - ts) > windowSec) return false;

    // Reconstruct the exact bytes the holder signed from the trusted claims.
    const message = popMessage({ aud: ctx.identity, jti: ctx.claims.jti, slug: ctx.slug, ts, nonce });
    const recovered = await recoverMessageAddress({ message, signature: sig as `0x${string}` });
    if (recovered.toLowerCase() !== bound) return false;

    // Single-use: spend (jti, nonce) once. expMs bounds how long we must remember
    // it — exactly the freshness window past the proof's timestamp.
    const key = `pop:${ctx.claims.jti}:${nonce}`;
    const expMs = (ts + windowSec) * 1000;
    if (!(await proofStore.consume(key, expMs, ctx.now))) return false; // replay

    return true;
  } catch {
    return false; // fail closed on any recover/parse error
  }
}
