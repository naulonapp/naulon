/**
 * The agent's wallet. With BUYER_PRIVATE_KEY set, derives the real Arc address
 * via viem and can sign holder-of-key proofs. Without it, falls back to a
 * deterministic DEV key (derived from a fixed non-secret seed, so it's stable
 * across processes) so the full loop — including the proof-of-possession re-read
 * across the two demo runs — works offline against the mock tollgate.
 * BUYER_ADDRESS still overrides the address for legacy/no-sign demos, but then
 * proofs won't match the dev key (re-read safely falls back to paying).
 */
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig } from "@naulon/shared";

export interface AgentWallet {
  address: string;
  mock: boolean;
  /** Sign an EIP-191 personal_sign message (a holder-of-key proof). */
  signMessage: (message: string) => Promise<string>;
}

/**
 * A deterministic, non-secret DEV key derived from a fixed seed — never used with
 * real funds. It gives the offline mock agent a consistent address+key (stable
 * across the two demo runs) so it can sign PoP proofs without any real wallet.
 * Derived at runtime so no key material is committed to the repo.
 */
function devDemoKey(): `0x${string}` {
  const bytes = createHash("sha256").update("naulon:dev-wallet:v1").digest();
  return `0x${bytes.toString("hex")}`;
}

function normalizeKey(raw: string): `0x${string}` {
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

export function getWallet(): AgentWallet {
  const cfg = getConfig();

  if (cfg.BUYER_PRIVATE_KEY) {
    const account = privateKeyToAccount(normalizeKey(cfg.BUYER_PRIVATE_KEY));
    return {
      address: account.address,
      mock: false,
      signMessage: (message) => account.signMessage({ message }),
    };
  }

  // No real key: use the derived dev key so the agent has a consistent signable
  // identity. A caller-supplied BUYER_ADDRESS still wins for the address (legacy
  // demos), but the dev key signs — only matching when BUYER_ADDRESS is unset.
  const account = privateKeyToAccount(devDemoKey());
  return {
    address: cfg.BUYER_ADDRESS ?? account.address,
    mock: true,
    signMessage: (message) => account.signMessage({ message }),
  };
}
