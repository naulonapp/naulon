/**
 * `networkByChainId` — the ledger stores a settlement's chain as a numeric `chainId`
 * (`AttributedEvent.chainId`), and a citation record minted from that row must name the
 * chain the money actually moved on. Every other lookup here is by name or CAIP-2.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeNetwork, NETWORKS, networkByChainId, networkForEvent } from "./networks.ts";

test("a known chainId resolves to its network", () => {
  const base = NETWORKS.base;
  assert.equal(networkByChainId(base.chainId)?.network, base.network);
});

test("every configured network is findable by its own chainId", () => {
  for (const net of Object.values(NETWORKS)) {
    assert.equal(networkByChainId(net.chainId)?.chainId, net.chainId, `${net.network} is unreachable by chainId`);
  }
});

test("an unknown chainId is undefined — the caller falls back, never guesses", () => {
  assert.equal(networkByChainId(999_999_999), undefined);
});

// ── networkForEvent — ONE owner for "which chain did this row settle on" ─────────
// The citation record and the re-issued access token are two projections of one ledger row, minted
// in two repos. Each carried its own copy of this fallback chain; a second copy is exactly where
// the two would stop naming the same chain.
test("networkForEvent: the row's chainId wins, then the tenant's network, then the fleet default", () => {
  const base = networkByChainId(8453)!;
  assert.equal(networkForEvent({ chainId: 8453 }, { settlementNetwork: "arcTestnet" }).chainId, base.chainId, "a stamped chainId is the truth");
  assert.equal(networkForEvent({}, { settlementNetwork: "arcTestnet" }).chainId, NETWORKS.arcTestnet.chainId, "a pre-chainId row falls back to the tenant");
  assert.equal(networkForEvent({}, {}).chainId, activeNetwork().chainId, "and then to the fleet default");
});
