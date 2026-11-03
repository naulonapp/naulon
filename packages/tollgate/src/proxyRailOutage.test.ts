/**
 * Proxy mode: when the payment rail cannot be asked, the gate serves the origin's page instead of
 * billing again, with no licence and no receipt, and records the read as free for `unavailable`.
 * When the rail answers "invalid", the read stays for sale. Gateway mode, with the facilitator and
 * the origin both behind a stubbed fetch, so the real settle path runs.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-railoutage-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "gateway";
process.env.SETTLEMENT_NETWORK = "arcTestnet";
process.env.GATEWAY_API_URL = "http://facilitator.test";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");

let facilitator: () => Response = () => new Response("<html>down</html>", { status: 503, headers: { "content-type": "text/html" } });
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input instanceof Request ? input.url : input).startsWith("http://facilitator.test")) return facilitator();
    return new Response("<html>origin article</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function payAttempt(): Promise<Response> {
  const first = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(first.status, 402);
  assert.ok(first.headers.get(PAYMENT_REQUIRED_HEADER));
  const sig = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00" } })).toString("base64");
  return app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig } });
}

test("a payment rail that cannot be asked serves the origin page, unbilled", async () => {
  facilitator = () => new Response("<html>down</html>", { status: 503, headers: { "content-type": "text/html" } });
  const res = await payAttempt();
  assert.equal(res.status, 200);
  assert.match(await res.text(), /origin article/);
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /served free \(payment rail unavailable\)/);
  assert.equal(res.headers.get("x-naulon-license"), null, "no licence for a read nobody paid");
  assert.equal(res.headers.get("payment-response"), null, "no receipt");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("a payment the rail calls invalid is still a 402", async () => {
  facilitator = () => new Response(JSON.stringify({ isValid: false, invalidReason: "invalid_signature" }), { status: 200, headers: { "content-type": "application/json" } });
  const res = await payAttempt();
  assert.equal(res.status, 402);
  facilitator = () => new Response(JSON.stringify({ error: "bad payload" }), { status: 400, headers: { "content-type": "application/json" } });
  assert.equal((await payAttempt()).status, 402);
});
