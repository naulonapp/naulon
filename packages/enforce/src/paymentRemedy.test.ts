import { test } from "node:test";
import assert from "node:assert/strict";
import { PAYMENT_FAILURE_REASONS } from "@naulon/shared";
import { paymentFailureDetail, FAILURE_DETAIL_MAX } from "./paymentRemedy.ts";
import { agentGuide } from "./agentGuide.ts";
import type { SettlementLegReq } from "./build402.ts";

const GW = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const leg = (gateway: boolean): SettlementLegReq => ({
  role: "author",
  requirements: {
    scheme: "exact", network: "eip155:5042", asset: "0x36", amount: "1000", payTo: "0xa", maxTimeoutSeconds: 1,
    extra: gateway ? { name: "GatewayWalletBatched", version: "1", verifyingContract: GW } : { nonce: "n" },
  },
});
const g = (gateway: boolean) => agentGuide({
  resource: { url: "https://e.example/x", title: "X" }, tollKind: "read", legs: [leg(gateway)],
  links: { guide: "https://g.example", manifest: "/m" },
});

test("every failure code has a remedy, an x402 code, and keeps the raw detail", () => {
  for (const code of PAYMENT_FAILURE_REASONS) {
    const d = paymentFailureDetail(code, "raw facilitator text", g(true));
    assert.equal(d.code, code);
    assert.match(d.x402Code, /^[a-z_]+$/);
    assert.ok(d.remedy.length > 20);
    assert.equal(d.detail, "raw facilitator text");
  }
});

test("insufficient funds on a gateway rail says deposit, and names the contract and network", () => {
  const d = paymentFailureDetail("insufficient_funds", "x", g(true));
  assert.match(d.remedy, /Gateway/);
  assert.ok(d.remedy.includes(GW));
  assert.ok(d.remedy.includes("Arc"));
  assert.ok(d.remedy.includes("USD 0.001"));
});

test("insufficient funds on a plain rail does not mention Gateway", () => {
  assert.doesNotMatch(paymentFailureDetail("insufficient_funds", "x", g(false)).remedy, /Gateway/);
});

test("a network refusal names the only network this toll settles on", () => {
  assert.ok(paymentFailureDetail("network_unsupported", "x", g(true)).remedy.includes("eip155:5042"));
});

test("an unknown settlement failure points at the guide", () => {
  assert.ok(paymentFailureDetail("settlement_failed", "x", g(true)).remedy.includes("https://g.example"));
});

test("a runaway facilitator string is bounded and flattened to one line", () => {
  const d = paymentFailureDetail("settlement_failed", `line1\nline2\t${"z".repeat(5000)}`, g(true));
  assert.ok(d.detail.length <= FAILURE_DETAIL_MAX);
  assert.doesNotMatch(d.detail, /\n|\t/);
});
