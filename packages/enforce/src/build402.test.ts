/**
 * build402 / buildRequirements — the 402 quote builder. These guard that the
 * advertised chain follows the quote's per-tenant `network` when set, and falls
 * back to the fleet `activeNetwork()` otherwise (the single-tenant default stays
 * byte-identical).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeNetwork, usdc, walletAddress } from "@naulon/shared";
import { build402, buildRequirements } from "./build402.ts";
import type { Quote } from "./pricing.ts";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    slug: "on-passage",
    title: "On Passage",
    kind: "read",
    price: usdc(0.001),
    payees: [{ authorId: "anna", wallet: walletAddress(WALLET), share: 1 }],
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

// The mode a quote was priced under travels with it, like `network`: a publisher's own runtime
// builds the 402 from a quote the control plane priced, and its local env defaults to mock.
function acceptsOf(header: string): Array<{ extra: Record<string, unknown> }> {
  return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts: Array<{ extra: Record<string, unknown> }> }).accepts;
}

test("build402 issues no nonce for a quote priced in gateway mode, whatever the local env says", () => {
  const built = build402(quote({ paymentMode: "gateway" }), "https://site.test/essays/x", 1_000);
  for (const a of acceptsOf(built.header)) assert.equal("nonce" in a.extra, false);
  for (const leg of built.legs) assert.equal("nonce" in leg.requirements.extra, false);
});

test("build402 issues a nonce for a quote priced in mock mode", () => {
  const built = build402(quote({ paymentMode: "mock" }), "https://site.test/essays/x", 1_000);
  for (const a of acceptsOf(built.header)) assert.equal(typeof a.extra.nonce, "string");
});
