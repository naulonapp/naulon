/**
 * build402 / buildRequirements — the 402 quote builder. These guard that the
 * advertised chain follows the quote's per-tenant `network` when set, and falls
 * back to the fleet `activeNetwork()` otherwise (the single-tenant default stays
 * byte-identical).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeNetwork, usdc, walletAddress } from "@naulon/shared";
import { buildRequirements } from "./build402.ts";
import type { Quote } from "./pricing.ts";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    slug: "on-passage",
    title: "On Passage",
    kind: "read",
    price: usdc(0.001),
    payees: [{ wallet: walletAddress(WALLET), share: 1 }],
    extraLegs: [],
    coauthorSplit: false,
    ...overrides,
  };
}

test("buildRequirements advertises the quote's per-tenant network when set", () => {
  const r = buildRequirements(quote({ network: "base" }));
  assert.equal(r.network, "eip155:8453");
  assert.equal(r.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // base USDC
  assert.equal(r.extra.verifyingContract, "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"); // base GatewayWallet
});

test("buildRequirements falls back to activeNetwork when the quote omits network", () => {
  const r = buildRequirements(quote());
  assert.equal(r.network, activeNetwork().network); // fleet default (SETTLEMENT_NETWORK)
  assert.equal(r.asset, activeNetwork().usdc);
});
