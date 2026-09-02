/**
 * `networkByChainId` — the ledger stores a settlement's chain as a numeric `chainId`
 * (`AttributedEvent.chainId`), and a citation record minted from that row must name the
 * chain the money actually moved on. Every other lookup here is by name or CAIP-2.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NETWORKS, networkByChainId } from "./networks.ts";

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
