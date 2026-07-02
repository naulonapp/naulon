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
 * can't sign (no key) — in which case the caller must fall back to paying.
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
  const sig = await wallet.signMessage(message);
  return `${ts}.${nonce}.${sig}`;
}
