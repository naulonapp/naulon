import assert from "node:assert/strict";
import { test } from "node:test";
import { publisherFromRecord, publisherRecordSchema, type PublisherRecord } from "./publisherRecord.ts";

const WALLET = "0x00000000000000000000000000000000000000a1";
const BASE: PublisherRecord = {
  id: "blog-1",
  hosts: ["one.example"],
  originUrl: "https://one.example",
  articlePrefixes: [],
  priceMicro: 5000,
};

const parse = (r: unknown) => publisherRecordSchema.safeParse(r);

test("rejects a float priceMicro", () => {
  assert.equal(parse({ ...BASE, priceMicro: 1.5 }).success, false);
});

test("rejects a negative priceMicro", () => {
  assert.equal(parse({ ...BASE, priceMicro: -1 }).success, false);
});

test("rejects an unknown settlement network", () => {
  assert.equal(parse({ ...BASE, settlementNetwork: "dogechain" }).success, false);
});

test("refuses the burn address as a payee", () => {
  assert.equal(parse({ ...BASE, defaultPayoutAddress: "0x0000000000000000000000000000000000000000" }).success, false);
});

test("refuses an unknown field rather than dropping it", () => {
  assert.equal(parse({ ...BASE, priceUsdc: 0.005 }).success, false);
});

test("converts priceMicro to the gate's price exactly", () => {
  assert.equal(publisherFromRecord(BASE).price, 0.005);
});

test("maps defaultPayoutAddress to one author leg for any article", async () => {
  const cfg = publisherFromRecord({ ...BASE, defaultPayoutAddress: WALLET });
  const credits = await cfg.credits.resolve("posts/hello");
  assert.equal(credits?.slug, "posts/hello");
  assert.deepEqual(credits?.contributors.map((c) => c.wallet), [WALLET]);
});

test("a record with no payee reads free", async () => {
  const cfg = publisherFromRecord(BASE);
  assert.equal(await cfg.credits.resolve("posts/hello"), undefined);
});

test("an inline credits pin wins over the site payee for its slug only", async () => {
  const pinned = "0x00000000000000000000000000000000000000b2";
  const cfg = publisherFromRecord({
    ...BASE,
    defaultPayoutAddress: WALLET,
    creditsInline: { "posts/pinned": { slug: "posts/pinned", title: "Pinned", contributors: [{ authorId: "b", wallet: pinned }] } },
  });
  assert.deepEqual((await cfg.credits.resolve("posts/pinned"))?.contributors.map((c) => c.wallet), [pinned]);
  assert.deepEqual((await cfg.credits.resolve("posts/other"))?.contributors.map((c) => c.wallet), [WALLET]);
});

test("passes toll mode, scope, terms and suspension through", () => {
  const cfg = publisherFromRecord({
    ...BASE,
    tollMode: "observe",
    gateScope: { mode: "site", excludePrefixes: ["/static/"] },
    termsPolicy: { "ai-train": "prohibit" },
    suspended: true,
  });
  assert.equal(cfg.tollMode, "observe");
  assert.deepEqual(cfg.gateScope, { mode: "site", excludePrefixes: ["/static/"] });
  assert.deepEqual(cfg.termsPolicy, { "ai-train": "prohibit" });
  assert.equal(cfg.suspended, true);
});

test("the licence identity names the record", () => {
  assert.equal(publisherFromRecord(BASE).licenseIdentity, "naulon:blog-1");
});

test("a per-site enforce key digest must be 64 lowercase hex characters", () => {
  assert.equal(parse({ ...BASE, enforceKeySha256: "abc" }).success, false);
  assert.equal(parse({ ...BASE, enforceKeySha256: "a".repeat(64) }).success, true);
  assert.equal(publisherFromRecord({ ...BASE, enforceKeySha256: "a".repeat(64) }).enforceKeySha256, "a".repeat(64));
});
