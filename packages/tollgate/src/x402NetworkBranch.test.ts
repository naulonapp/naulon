/**
 * The settle path must branch memo-vs-gateway on the LEG's advertised network, not
 * the fleet-global `SETTLEMENT_NETWORK`. This is the security-relevant per-tenant
 * guarantee: a memo-capable (Arc) leg self-relays even when the fleet default is a
 * memo-less gateway chain, and vice-versa. Proven offline via the memo path's
 * distinctive early guard (no relayer key), so no facilitator network call runs.
 *
 * Env is set BEFORE importing x402 (its `cfg` is captured at module load), so this
 * lives in its own file with its own process — it must not leak PAYMENT_MODE into
 * the mock-default suite.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequirements } from "./x402.ts";

// Fleet default = baseSepolia (a memo-LESS gateway chain). Gateway mode. No relayer.
process.env.PAYMENT_MODE = "gateway";
process.env.SETTLEMENT_NETWORK = "baseSepolia";
process.env.LICENSES_ENABLED = "false"; // no signing key needed — we only reach the settle branch
delete process.env.RELAYER_PRIVATE_KEY;

const { resetConfig } = await import("@naulon/shared");
resetConfig();
const { verifyAndSettle } = await import("./x402.ts");

/** An Arc (memo-capable) leg — a per-tenant chain that differs from the fleet default. */
function arcLeg(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:5042002", // Arc testnet — ships the Memo predeploy
    asset: "0x3600000000000000000000000000000000000000",
    amount: "1000",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 691_200,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
  };
}

test("an Arc leg routes to the MEMO settle path even when the fleet default is baseSepolia (gateway)", async () => {
  // Payload is irrelevant: the memo path's relayer-key guard fires first. If the
  // branch wrongly keyed off the baseSepolia fleet default it would take the GATEWAY
  // path (a facilitator network call) and never emit this error.
  const sig = Buffer.from(JSON.stringify([{ authorization: {}, signature: "0x00" }])).toString("base64");
  const res = await verifyAndSettle(sig, [{ role: "author", requirements: arcLeg() }], Date.now());
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /RELAYER_PRIVATE_KEY required for memo-network settlement/);
});
