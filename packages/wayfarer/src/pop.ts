/**
 * Buyer-side holder-of-key proof. When the agent holds a cnf-bound license, a
 * free re-read requires proving it controls the payer wallet: it signs a fresh
 * challenge (EIP-191) over the same canonical bytes the gate reconstructs.
 *
 * The proof wire format is `<ts>.<nonce>.<sig>` (see tollgate/src/pop.ts). `ts`
 * is the agent's current epoch-seconds (the gate checks it against a freshness
 * window), `nonce` is a single-use random salt, `sig` is the wallet signature.
 */
import { randomBytes } from "node:crypto";
import { popMessage } from "@naulon/shared";
import type { HeldLicense } from "./licenseStore.ts";
import type { AgentWallet } from "./wallet.ts";

/**
 * Build a proof-of-possession header for a held license, or null if the wallet
 * can't sign (no key, or the signer itself failed) — in which case the caller
 * must fall back to paying.
 *
 * `wallet.signMessage` is a real op on the hosted path — `cloudPopSigner`
 * (wayfarer-mcp/cloud-signer.ts) POSTs to `/_naulon/buyer-wallet/sign-pop` and
 * THROWS a `SignerError` on any non-2xx (network blip, expired session, 5xx).
 * A held-license re-read is a best-effort free path, exactly like the re-read
 * fetch itself (A1) — so a signing failure here must degrade to the same "can't
 * sign" null, not propagate an uncaught rejection through every caller (run()'s
 * cache branch, naulon_read_held) and crash the whole operation over one
 * skippable decision (FU-A1b).
 */
export async function buildPopProof(
  held: HeldLicense,
  wallet: AgentWallet,
  now: number,
): Promise<string | null> {
  if (!wallet.signMessage) return null;
  const ts = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString("hex");
  const message = popMessage({ aud: held.aud, jti: held.jti, slug: held.slug, ts, nonce });
  let sig: string;
  try {
    sig = await wallet.signMessage(message);
  } catch {
    return null;
  }
  return `${ts}.${nonce}.${sig}`;
}
