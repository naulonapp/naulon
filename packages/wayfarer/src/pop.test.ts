/**
 * Buyer-side proof-of-possession: the `<ts>.<nonce>.<sig>` header an agent
 * signs to prove wallet control on a free re-read of a cnf-bound license.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { popMessage } from "@naulon/shared";
import { buildPopProof } from "./pop.ts";
import type { HeldLicense } from "./licenseStore.ts";
import type { AgentWallet } from "./wallet.ts";

const HELD: HeldLicense = {
  slug: "the-naulon",
  title: "The Naulon",
  jti: "jti-123",
  exp: 9999999999,
  aud: "gate://naulon",
  pop: true,
  jws: "header.payload.sig",
};

test("returns null when the wallet cannot sign — caller must fall back to paying", async () => {
  const noSign: AgentWallet = {
    address: "0xabc",
    mock: true,
    // @ts-expect-error — testing the runtime guard for a wallet that can't sign
    signMessage: undefined,
  };
  assert.equal(await buildPopProof(HELD, noSign, 1_700_000_000_000), null);
});

test("emits a three-part <ts>.<nonce>.<sig> proof", async () => {
  const wallet: AgentWallet = {
    address: "0xabc",
    mock: true,
    signMessage: async () => "0xSIGNATURE",
  };
  const proof = await buildPopProof(HELD, wallet, 1_700_000_000_500);
  assert.ok(proof);
  const [ts, nonce, sig] = proof!.split(".");
  assert.equal(ts, "1700000000", "ts is epoch SECONDS, floored from epoch ms");
  assert.match(nonce ?? "", /^[0-9a-f]{32}$/, "nonce is a 16-byte hex salt");
  assert.equal(sig, "0xSIGNATURE");
});

test("signs the canonical popMessage the gate will reconstruct", async () => {
  let signed: string | undefined;
  const wallet: AgentWallet = {
    address: "0xabc",
    mock: true,
    signMessage: async (m) => {
      signed = m;
      return "0xSIG";
    },
  };
  const proof = await buildPopProof(HELD, wallet, 1_700_000_000_000);
  const [ts, nonce] = proof!.split(".");
  assert.equal(
    signed,
    popMessage({ aud: HELD.aud, jti: HELD.jti, slug: HELD.slug, ts: Number(ts), nonce: nonce! }),
  );
});

test("each proof carries a fresh single-use nonce", async () => {
  const wallet: AgentWallet = { address: "0xabc", mock: true, signMessage: async () => "0xSIG" };
  const a = await buildPopProof(HELD, wallet, 1_700_000_000_000);
  const b = await buildPopProof(HELD, wallet, 1_700_000_000_000);
  assert.notEqual(a!.split(".")[1], b!.split(".")[1]);
});
