/**
 * A payment rail that cannot be asked is a gate failure, which serves the read; an answer about the
 * payment is not. The line must sit where a buyer cannot cross it with their own payload, so this
 * drives the real gateway path against a local facilitator that misbehaves in each way.
 * Env is set BEFORE importing x402 so the module-level config binds gateway mode and the stub URL.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

type Reply = { status: number; body: string; type?: string } | "hang" | "destroy";
let reply: Reply = { status: 200, body: "{}" };

const server: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (reply === "hang") return;
    if (reply === "destroy") return void res.socket?.destroy();
    res.writeHead(reply.status, { "content-type": reply.type ?? "application/json" });
    res.end(reply.body);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

process.env.PAYMENT_MODE = "gateway";
process.env.SETTLEMENT_NETWORK = "arcTestnet";
process.env.GATEWAY_API_URL = `http://127.0.0.1:${port}`;
process.env.LICENSES_ENABLED = "false";

const x402 = await import("./x402.ts");
const { NETWORKS } = await import("@naulon/shared");

const ARC = NETWORKS.arcTestnet;
const LEGS = [
  {
    role: "author",
    requirements: { scheme: "exact", network: ARC.network, asset: ARC.usdc, amount: "5000", payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 600, extra: {} },
  },
] as never;
const PAYMENT = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00" } })).toString("base64");

before(() => x402.setFacilitatorVerifyTimeoutForTest(300));
after(() => {
  x402.setFacilitatorVerifyTimeoutForTest();
  server.close();
});

async function verifyWith(r: Reply) {
  reply = r;
  return x402.verifyAndSettle(PAYMENT, LEGS, Date.now(), "pub_a");
}

test("a facilitator that cannot be asked marks the refusal unavailable", async () => {
  for (const r of [
    "hang",
    "destroy",
    { status: 503, body: "<html>Service Unavailable</html>", type: "text/html" },
    { status: 502, body: JSON.stringify({ error: "bad gateway" }) },
    { status: 504, body: JSON.stringify({ error: "timeout" }) },
    { status: 200, body: "not json", type: "text/plain" },
  ] as Reply[]) {
    const out = await verifyWith(r);
    assert.equal(out.ok, false, JSON.stringify(r));
    assert.equal(out.stage, "verify", "nothing was broadcast");
    assert.equal(out.unavailable, true, `${JSON.stringify(r)}: ${out.error}`);
  }
});

test("a facilitator that answers about the payment is a refusal, never unavailable", async () => {
  for (const r of [
    { status: 400, body: JSON.stringify({ error: "invalid payload" }) },
    { status: 500, body: JSON.stringify({ error: "internal" }) },
    { status: 200, body: JSON.stringify({ isValid: false, invalidReason: "invalid_signature" }) },
  ] as Reply[]) {
    const out = await verifyWith(r);
    assert.equal(out.ok, false, JSON.stringify(r));
    assert.equal(out.unavailable, undefined, `${JSON.stringify(r)}: ${out.error}`);
  }
});

test("the classifier reads causes, not wording a payload could steer", () => {
  assert.equal(x402.facilitatorUnavailable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(x402.facilitatorUnavailable(Object.assign(new Error("x"), { cause: { code: "UND_ERR_SOCKET" } })), true);
  assert.equal(x402.facilitatorUnavailable(new Error(`Circle Gateway verify failed (400): {"error":"x"}`)), false);
  assert.equal(x402.facilitatorUnavailable(new Error(`Circle Gateway verify failed (503): {}`)), true);
  assert.equal(x402.facilitatorUnavailable("a string"), false);
});
