/**
 * `getWallet` behavioral coverage (the carried BUY-0 gap — it had only a smoke
 * `typeof` test). The three config paths matter because the wallet is the buyer's
 * identity and the PoP signer: the deterministic DEV key must be stable across
 * processes (so a license held in one run re-reads in the next), a real
 * BUYER_PRIVATE_KEY must drive the viem account, and a bare BUYER_ADDRESS must
 * override the address while leaving signing to the dev key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resetConfig } from "@naulon/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { getWallet } from "./wallet.ts";

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  resetConfig();
  try {
    return await fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    resetConfig();
  }
}

test("with no key, getWallet derives a deterministic, signable DEV identity (stable across calls)", async () => {
  await withEnv({ BUYER_PRIVATE_KEY: undefined, BUYER_ADDRESS: undefined }, async () => {
    const a = getWallet();
    const b = getWallet();
    assert.equal(a.mock, true, "no real key → mock wallet");
    assert.match(a.address, /^0x[0-9a-fA-F]{40}$/, "a real-shaped address");
    assert.equal(a.address, b.address, "the dev key is deterministic — same address every call");
    assert.ok(a.signMessage, "the dev path can still sign PoP proofs");
    const sig = await a.signMessage!("proof");
    assert.match(sig, /^0x[0-9a-fA-F]+$/, "produces an EIP-191 signature");
  });
});

test("with BUYER_PRIVATE_KEY set, getWallet drives the real viem account (not mock)", async () => {
  // A throwaway key generated at runtime — never a committed/real wallet.
  const key = generatePrivateKey();
  await withEnv({ BUYER_PRIVATE_KEY: key, BUYER_ADDRESS: undefined }, async () => {
    const w = getWallet();
    assert.equal(w.mock, false, "a real key → not a mock wallet");
    assert.equal(w.address, privateKeyToAccount(key).address, "address is derived from the key via viem");
    assert.ok(w.signMessage, "and it can sign");
  });
});

test("a bare BUYER_ADDRESS overrides the address but signing stays on the dev key", async () => {
  const addr = "0x00000000000000000000000000000000000000Ad";
  await withEnv({ BUYER_PRIVATE_KEY: undefined, BUYER_ADDRESS: addr }, async () => {
    const w = getWallet();
    assert.equal(w.mock, true, "no private key → still a mock wallet");
    assert.equal(w.address, addr, "the explicit address wins for legacy/no-sign demos");
    assert.ok(w.signMessage, "the dev key still backs signing (won't match the overridden address)");
  });
});
