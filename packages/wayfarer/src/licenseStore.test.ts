/**
 * The agent's license wallet: decode a captured token, judge liveness, persist.
 * Uses a tmp store path set before importing the module (config reads env once).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WAYFARER_LICENSE_PATH = join(tmpdir(), `naulon-held-${process.pid}.json`);

const { loadHeld, saveHeld, decodeHeld, isLive, memoryHeldStore, fileHeldStore } = await import(
  "./licenseStore.ts"
);
const { mintLicense, loadSigningKey } = await import("@naulon/shared");
type HeldLicense = import("./licenseStore.ts").HeldLicense;

const KEY = loadSigningKey();
const NOW = 1_700_000_000_000;
const NETWORK = { chainId: 5042002, usdc: "0x36", gateway: "g" };

function token(slug: string, ttl = 600): string {
  return mintLicense(
    {
      event: {
        id: `id-${slug}`,
        slug,
        kind: "citation",
        amount: 0.005 as never,
        payees: [{ authorId: "a", wallet: "0x1111111111111111111111111111111111111111" as never, share: 1 }],
        payerAddress: "0x2222222222222222222222222222222222222222" as never,
        settlementRef: "ref",
        at: NOW,
      },
      issuer: "naulon:test",
      audience: "naulon:test",
      ttlSeconds: ttl,
      payeesMode: "full",
      title: `Title ${slug}`,
      network: NETWORK,
    },
    KEY,
    NOW,
  );
}

test("decodeHeld extracts jti, exp (seconds) and slug from a real token", () => {
  const decoded = decodeHeld(token("on-stillness"));
  assert.ok(decoded);
  assert.equal(decoded!.slug, "on-stillness");
  assert.equal(decoded!.jti, "id-on-stillness");
  assert.equal(decoded!.exp, Math.floor(NOW / 1000) + 600);
  assert.equal(decoded!.title, "Title on-stillness");
});

test("decodeHeld returns null on garbage", () => {
  assert.equal(decodeHeld("not-a-token"), null);
});

test("isLive respects exp against now (seconds)", () => {
  const h: HeldLicense = { slug: "s", title: "t", jti: "j", exp: 1000, aud: "naulon:test", pop: false, jws: "x" };
  assert.equal(isLive(h, 999), true);
  assert.equal(isLive(h, 1000), false);
  assert.equal(isLive(h, 1001), false);
});

test("save then load round-trips the held licenses by slug", async () => {
  const decoded = decodeHeld(token("the-naulon"))!;
  const map = new Map<string, HeldLicense>([["the-naulon", { ...decoded, jws: token("the-naulon") }]]);
  await saveHeld(map);
  const loaded = await loadHeld();
  assert.equal(loaded.size, 1);
  assert.equal(loaded.get("the-naulon")?.jti, "id-the-naulon");
});

test("memoryHeldStore round-trips within one instance", async () => {
  const decoded = decodeHeld(token("the-naulon"))!;
  const store = memoryHeldStore();
  await store.save(new Map([["the-naulon", { ...decoded, jws: token("the-naulon") }]]));
  const loaded = await store.load();
  assert.equal(loaded.get("the-naulon")?.jti, "id-the-naulon");
});

test("memoryHeldStore isolates sessions — B cannot read what A saved (the hosted leak)", async () => {
  const decoded = decodeHeld(token("secret-essay"))!;
  const sessionA = memoryHeldStore();
  const sessionB = memoryHeldStore();
  // A pays and holds a license.
  await sessionA.save(new Map([["secret-essay", { ...decoded, jws: token("secret-essay") }]]));
  // B (a different buyer's session, same process) must see nothing.
  const bView = await sessionB.load();
  assert.equal(bView.size, 0);
  assert.equal(bView.get("secret-essay"), undefined);
  // And A still holds its own — isolation, not amnesia.
  assert.equal((await sessionA.load()).get("secret-essay")?.jti, "id-secret-essay");
});

test("memoryHeldStore load returns a copy — mutating it never leaks back into the store", async () => {
  const store = memoryHeldStore();
  const decoded = decodeHeld(token("the-naulon"))!;
  await store.save(new Map([["the-naulon", { ...decoded, jws: token("the-naulon") }]]));
  const view = await store.load();
  view.set("injected", { slug: "injected", title: "x", jti: "j", exp: 1, aud: "a", pop: false, jws: "z" });
  assert.equal((await store.load()).has("injected"), false);
});

test("fileHeldStore is the process-global file default (load/save delegate to it)", async () => {
  const decoded = decodeHeld(token("file-essay"))!;
  await fileHeldStore.save(new Map([["file-essay", { ...decoded, jws: token("file-essay") }]]));
  // Read through the bare functions to prove fileHeldStore IS the file (same backend).
  assert.equal((await loadHeld()).get("file-essay")?.jti, "id-file-essay");
  assert.equal((await fileHeldStore.load()).get("file-essay")?.jti, "id-file-essay");
});
