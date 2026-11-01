import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublisherConfig } from "@naulon/shared";
import { buyerTotalFrom, termsFor } from "./terms.ts";

const PUB = { articlePrefixes: ["/articles"], price: 0.02, citationMultiplier: 5 };
const tenPercent = ((price: number) => [{ role: "operator", payTo: "0x" + "c0".repeat(20), amount: String(Math.round(price * 100_000)) }]) as unknown as NonNullable<PublisherConfig["extraLegs"]>;

test("the buyer total is the price plus every additive leg, summed in micro-USDC", () => {
  assert.equal(buyerTotalFrom(tenPercent)(0.02, "read"), 0.022);
  assert.equal(buyerTotalFrom(tenPercent)(0.001, "read"), 0.0011);
});

test("the fee hook is asked with the toll kind", () => {
  const seen: string[] = [];
  const spy = ((_p: never, kind: string) => { seen.push(kind); return []; }) as unknown as NonNullable<PublisherConfig["extraLegs"]>;
  buyerTotalFrom(spy)(0.02, "read");
  buyerTotalFrom(spy)(0.1, "citation");
  assert.deepEqual(seen, ["read", "citation"]);
});

test("termsFor carries the fee hook through, and omits it when there are no extra legs", () => {
  assert.equal(termsFor("alpha.test", { ...PUB, extraLegs: tenPercent }).buyerTotalUsdc?.(0.02, "read"), 0.022);
  assert.equal("buyerTotalUsdc" in termsFor("alpha.test", PUB), false);
});

test("termsFor names the licence server only when the publisher has one", () => {
  assert.equal(termsFor("alpha.test", { ...PUB, licenceServer: "https://ls.example" }).licenceServer, "https://ls.example");
  assert.equal("licenceServer" in termsFor("alpha.test", PUB), false);
});
