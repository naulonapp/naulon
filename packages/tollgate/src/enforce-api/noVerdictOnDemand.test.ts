// A runtime serves the page free when the gate gives no verdict (docs/protocol/in-app.md, rule 4),
// and a 5xx is no verdict. So no input a buyer controls may produce a 5xx here: if one did, that
// payment or licence would read free on demand. Runs the real settle and licence check, unstubbed.
process.env.PAYMENT_MODE = "mock";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import { build402 } from "@naulon/enforce";
import { mountFromHostedDeps } from "./hostedDeps.testkit.ts";

const publisher = { id: "pub_a", suspended: false, originUrl: "http://o", articlePrefixes: ["essays"], licenseIdentity: "did:web:t" };

function app() {
  const a = new OpenAPIHono();
  mountFromHostedDeps(a, {
    resolver: { resolve: async () => publisher } as never,
    apiKeyResolve: async () => ({ tenantId: "pub_a" }),
  });
  return a;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const CRAFTED_PAYMENTS = [
  "",
  "!!!not-base64!!!",
  b64("null"),
  b64("[]"),
  b64("[null]"),
  b64("[null,null]"),
  b64("1"),
  b64('"x"'),
  b64("{}"),
  b64('{"payload":null}'),
  b64('{"payload":{"authorization":null,"signature":7}}'),
  b64(JSON.stringify({ x402Version: 2, payload: { authorization: { from: 1, value: {} } } })),
  "A".repeat(200_000),
];
const RESOURCE = "http://h.test/essays/x";
const QUOTE = {
  slug: "essays/x",
  title: "x",
  kind: "read",
  price: 0.001,
  payees: [{ authorId: "a", wallet: `0x${"1".repeat(40)}`, share: 1 }],
  extraLegs: [],
};
const keyHeaders = { authorization: "Bearer k", "content-type": "application/json" };

test("no crafted payment makes /verify answer 5xx", async () => {
  const a = app();
  for (const payment of CRAFTED_PAYMENTS) {
    const res = await a.request("/_naulon/verify", {
      method: "POST",
      headers: keyHeaders,
      // A real quote and its own legs, so each payment reaches the settle path rather than stopping
      // at the quote check.
      body: JSON.stringify({ payment, legs: build402(QUOTE as never, RESOURCE, Date.now()).legs, quote: QUOTE, resource: RESOURCE }),
    });
    assert.ok(res.status < 500, `payment ${payment.slice(0, 40)} answered ${res.status}`);
    // Past the request schema, every one must reach the settle path, or this test proves nothing.
    if (payment !== "") assert.equal(res.status, 402, `payment ${payment.slice(0, 40)}: ${await res.text()}`);
  }
});

test("no crafted licence makes /license/check answer 5xx", async () => {
  const a = app();
  const licences = ["x", "a.b.c", `${b64("{}")}.${b64("null")}.sig`, `${b64('{"alg":"none"}')}.${b64("{}")}.`, "e".repeat(100_000), "..", "a.b.c.d.e"];
  for (const license of licences) {
    const res = await a.request("/_naulon/license/check", {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ license, resource: "http://h.test/essays/x", slug: "essays/x", kind: "read", proof: "junk" }),
    });
    assert.ok(res.status < 500, `licence ${license.slice(0, 40)} answered ${res.status}`);
  }
});
