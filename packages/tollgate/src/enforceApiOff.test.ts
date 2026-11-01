/**
 * With NAULON_ENFORCE_KEY unset the gate serves none of the enforce routes: every one of them is
 * proxied to the origin exactly as before the API existed.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-enforce-off-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";
delete process.env.NAULON_ENFORCE_KEY;

const { createApp } = await import("./app.ts");
const { usdc } = await import("@naulon/shared");

const app = createApp({
  async resolve() {
    return { id: "p", originUrl: "http://origin.local", articlePrefixes: ["essays"], price: usdc(0.001), citationMultiplier: 1, credits: { resolve: async () => undefined }, licenseIdentity: "naulon:p" };
  },
});
const ORIGIN_BODY = "<html>origin</html>";
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = (async () => new Response(ORIGIN_BODY, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch; });
after(() => { globalThis.fetch = realFetch; });

test("with NAULON_ENFORCE_KEY unset /_naulon/quote reaches the origin", async () => {
  const res = await app.request("/_naulon/quote?resource=http://h/x&slug=x", { headers: { host: "h" } });
  assert.equal(await res.text(), ORIGIN_BODY);
});

test("with NAULON_ENFORCE_KEY unset there is no OpenAPI document either", async () => {
  const res = await app.request("/_naulon/openapi.json", { headers: { host: "h" } });
  assert.equal(await res.text(), ORIGIN_BODY);
});
