/**
 * The hosted `POST /_naulon/license/check` is the entitlement answer for every runtime that
 * cannot verify a JWS itself — PHP, Python, Ruby; the WordPress plugin is the live case. So
 * the rule "a CITATION RECORD entitles nothing" has to hold HERE, not only inside the gate.
 *
 * These drive the REAL `licenseEntitlesRead` (no injected stub), against a real signing key,
 * with a real minted licence and a real minted record. Same key, same issuer, same slug — the
 * ONLY difference between the two cases is the grant, which is what makes the refusal
 * attributable to the grant and not to some incidental defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";

const KEY_B64 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

const { mountFromHostedDeps: mountEnforceLicense } = await import("./hostedDeps.testkit.ts");
const { jwksOf, loadSigningKey, mintCitationRecord, mintLicense } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const ISS = "https://gate.naulon.app";
const KEY = loadSigningKey(KEY_B64);
const NOW = Date.now();
const event = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "on-stillness",
  kind: "read",
  amount: 0.003,
  payees: [{ authorId: "mira", wallet: `0x${"1".repeat(40)}`, share: 1 }],
  payerAddress: `0x${"3".repeat(40)}`,
  settlementRef: "0xref",
  at: NOW,
} as never;
const mintInput = {
  event,
  issuer: ISS,
  audience: ISS,
  ttlSeconds: 3600,
  payeesMode: "full",
  title: "On Stillness",
  network: { chainId: 8453, usdc: `0x${"8".repeat(40)}`, gateway: "base" },
} as never;

/** The endpoint wired to the REAL entitlement check — no `entitles` stub. `licenseKeys` is what
 *  a gate passes in production: its own published key, the one that minted the licence. */
function realApp(licenseKeys: ReturnType<typeof jwksOf> | null = jwksOf([KEY])): OpenAPIHono {
  const app = new OpenAPIHono();
  mountEnforceLicense(app, {
    licenseKeys: licenseKeys ?? undefined,
    resolver: {
      resolve: async () => ({ id: "pub_a", licenseIdentity: ISS, suspended: false }) as PublisherConfig,
    } as never,
    verify: (async () => null) as never,
    apiKeyResolve: (async () => ({ tenantId: "pub_a", ownerUserId: "u1", scopes: ["tenant.read"] })) as never,
  });
  return app;
}

const ask = (app: OpenAPIHono, license: string) =>
  app.request("/_naulon/license/check", {
    method: "POST",
    headers: { authorization: "Bearer nln_live_test", "content-type": "application/json" },
    body: JSON.stringify({
      license,
      resource: "https://publisher.example/essays/on-stillness",
      slug: "on-stillness",
      kind: "read",
    }),
  });

test("a real access licence entitles the re-read through the hosted check", async () => {
  const res = await ask(realApp(), mintLicense(mintInput, KEY, NOW));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: true, verdict: "paid" });
});

test("with licensing off the check says no_verifier, the one reason a caller may see", async () => {
  const res = await ask(realApp(null), mintLicense(mintInput, KEY, NOW));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused", reason: "no_verifier" });
});

test("a licence signed by a key the gate does not hold is refused, with no reason given", async () => {
  const stranger = loadSigningKey();
  const res = await ask(realApp(), mintLicense(mintInput, stranger, NOW));
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused" });
});

test("a CITATION RECORD does not — the WordPress path refuses it too", async () => {
  const res = await ask(realApp(), mintCitationRecord(mintInput, KEY, NOW));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { entitled: false, verdict: "refused" }, "a record grants nothing, on every runtime");
});

test("a scoped licence entitles a path inside its scope", async () => {
  const scoped = mintLicense({ ...(mintInput as object), scope: { patterns: ["/essays/*"] } } as never, KEY, NOW);
  assert.deepEqual(await (await ask(realApp(), scoped)).json(), { entitled: true, verdict: "paid" });
});

test("a scoped licence is refused outside its scope", async () => {
  const scoped = mintLicense({ ...(mintInput as object), scope: { patterns: ["/journal/*"] } } as never, KEY, NOW);
  assert.deepEqual(await (await ask(realApp(), scoped)).json(), { entitled: false, verdict: "refused" });
});
