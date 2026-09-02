/**
 * W6 — the buyer's held-licence store must never hold a CITATION RECORD.
 *
 * A record is permanent and grants nothing. `decodeHeld` has always required `exp`, so a
 * record already falls out — but that is now load-bearing rather than incidental, and an
 * explicit grant check states the rule where a reader will look for it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jwksOf, loadSigningKey, mintCitationRecord, mintLicense } from "@naulon/shared";
import { decodeHeld } from "./licenseStore.ts";

const KEY = loadSigningKey();
void jwksOf([KEY]);
const NOW = Date.now();
const ISS = "naulon:test.example";
const event = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  kind: "citation",
  amount: 0.005,
  payees: [{ authorId: "mira", wallet: `0x${"1".repeat(40)}`, share: 1 }],
  payerAddress: `0x${"3".repeat(40)}`,
  settlementRef: "ref",
  at: NOW,
} as never;
const input = {
  event,
  issuer: ISS,
  audience: ISS,
  ttlSeconds: 600,
  payeesMode: "full",
  title: "On Stillness",
  network: { chainId: 1, usdc: "0x0", gateway: "base" },
} as never;

test("an access licence is still decoded and held", () => {
  const held = decodeHeld(mintLicense(input, KEY, NOW));
  assert.notEqual(held, null);
  assert.equal(held?.slug, "on-stillness");
});

test("a citation record is NEVER held — it entitles no read", () => {
  assert.equal(decodeHeld(mintCitationRecord(input, KEY, NOW)), null);
});

test("a token whose grant is unrecognised is not held either", () => {
  // Fail closed: a grant kind invented later must not become a re-read entitlement here.
  const jws = mintLicense(input, KEY, NOW);
  const [h, p, s] = jws.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  (claims["naulon"] as Record<string, unknown>)["grant"] = "someday";
  const tampered = `${h}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${s}`;
  assert.equal(decodeHeld(tampered), null);
});

test("a scoped access licence keeps its scope when decoded", () => {
  const held = decodeHeld(mintLicense({ ...(input as object), scope: { patterns: ["/essays/*"] } } as never, KEY, NOW));
  assert.deepEqual(held?.scope, { patterns: ["/essays/*"] });
});
