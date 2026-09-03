/**
 * A settle can now mint a SALE licence, and a toll still mints exactly what it always did.
 *
 * `settleAndAttribute` grew one optional `licence` argument so a licence sold over a scope
 * settles through the SAME verify, the same buyer→author legs and the same custody-free rule as
 * a toll — rather than through a second money path that would have to be defended against drift
 * forever. The only difference between the two is what the minted claim says, and that is what
 * this file pins.
 *
 * The first test is the one that matters most: with no `licence` argument, the claim must carry
 * no scope, no terms, no period, and `sub` must still be the payer wallet. Every licence minted
 * before this field existed has that shape, and a verifier holding one must not be able to tell
 * that the gate changed.
 *
 * Driven through the real settle in PAYMENT_MODE=mock, with licensing on and a generated key, so
 * these are real signed tokens read back through the real verifier.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "naulon-settle-licence-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.LICENSES_ENABLED = "true";
// A throwaway Ed25519 key, PKCS8 PEM — the same shape the box supplies from SSM.
process.env.LICENSE_SIGNING_KEY = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const { resetConfig, usdc, walletAddress, NETWORKS, verifyLicense, licenseGrant } = await import(
  "@naulon/shared"
);
type CitationLicenseClaims = Extract<ReturnType<typeof verifyLicense>, { ok: true }>["claims"];
resetConfig();
const { settleAndAttribute } = await import("./settle.ts");
const { licensing } = await import("@naulon/enforce");
const { bindingOf, issueNonce } = await import("@naulon/enforce");

const PAYEE = walletAddress("0x1111111111111111111111111111111111111111");
const PAYER = "0x2222222222222222222222222222222222222222";

function authorLeg() {
  return {
    role: "author" as const,
    requirements: {
      scheme: "exact",
      network: NETWORKS.baseSepolia.network,
      asset: NETWORKS.baseSepolia.usdc,
      amount: "5000",
      payTo: PAYEE,
      maxTimeoutSeconds: 691_200,
    },
  };
}

function payment(now: number): string {
  const nonce = issueNonce(bindingOf(authorLeg().requirements as never), now);
  return Buffer.from(JSON.stringify([{ payer: PAYER, amount: "5000", nonce }])).toString("base64");
}

function args(now: number, licence?: Parameters<typeof settleAndAttribute>[0]["licence"]) {
  return {
    payment: payment(now),
    legs: [authorLeg()] as never,
    quote: {
      slug: "essays/a",
      title: "An essay",
      kind: "read" as const,
      price: usdc(0.005),
      payees: [{ authorId: "ann", wallet: PAYEE, share: 1 }],
      extraLegs: [],
    } as never,
    publisher: {
      id: "pub-1",
      originUrl: "https://example.test",
      licenseIdentity: "https://example.test",
    } as never,
    host: "example.test",
    now,
    ...(licence ? { licence } : {}),
  };
}

async function claimsOf(res: Awaited<ReturnType<typeof settleAndAttribute>>): Promise<CitationLicenseClaims> {
  assert.equal(res.ok, true, `settle failed: ${JSON.stringify(res)}`);
  const jws = (res as { licenseJws?: string }).licenseJws;
  assert.ok(jws, "expected a minted licence");
  const verified = verifyLicense(jws, {
    now: Math.floor(Date.now() / 1000),
    expectedIssuer: "https://example.test",
    expectedAudience: "https://example.test",
    jwks: licensing!.jwks,
  });
  assert.equal(verified.ok, true, `licence did not verify: ${JSON.stringify(verified)}`);
  if (!verified.ok) throw new Error("unreachable");
  return verified.claims;
}

test("a toll mints exactly what it always did — no scope, no terms, no period, sub = the payer", async () => {
  const c = await claimsOf(await settleAndAttribute(args(Math.floor(Date.now() / 1000))));
  assert.equal(c.naulon.scope, undefined);
  assert.equal(c.naulon.terms, undefined);
  assert.equal(c.naulon.period, undefined);
  assert.equal(c.naulon.grant, undefined, "absent grant is what makes an old verifier read it as a read");
  assert.equal(c.sub.toLowerCase(), PAYER.toLowerCase());
  assert.equal(licenseGrant(c.naulon as never), "read");
});

test("a sale carries the scope, terms, period and subject through to the claim", async () => {
  const now = Math.floor(Date.now() / 1000);
  const period = { from: now, until: now + 30 * 86_400 };
  const c = await claimsOf(
    await settleAndAttribute(
      args(now, {
        scope: { patterns: ["/essays/*"] },
        terms: ["ai-input"],
        period,
        subject: "acct:11111111-1111-4111-8111-111111111111",
      }),
    ),
  );
  assert.deepEqual(c.naulon.scope, { patterns: ["/essays/*"] });
  assert.deepEqual(c.naulon.terms, ["ai-input"]);
  assert.deepEqual(c.naulon.period, period);
  assert.equal(c.sub, "acct:11111111-1111-4111-8111-111111111111");
});

test("a successful settle names the event id, which is the licence jti", async () => {
  // A caller keying its own record by the licence must not have to decode the token to learn its
  // id. Both halves are asserted together so they cannot drift apart.
  const now = Math.floor(Date.now() / 1000);
  const res = await settleAndAttribute(args(now));
  assert.equal(res.ok, true);
  assert.ok(res.eventId, "expected the event id back");
  const c = await claimsOf(res);
  assert.equal(c.jti, res.eventId);
});

test("a sale's purchased PERIOD is not its re-read window — exp stays the TTL", async () => {
  // The whole reason period is a separate field: a 30-day licence must not become a 30-day
  // bearer token. `exp` is the kill switch and stays capped at the TTL.
  const now = Math.floor(Date.now() / 1000);
  const c = await claimsOf(
    await settleAndAttribute(
      args(now, { scope: { patterns: ["/essays/*"] }, period: { from: now, until: now + 30 * 86_400 } }),
    ),
  );
  assert.ok(c.exp !== undefined, "an access licence must still expire");
  assert.ok(c.exp - now <= 3600, `exp is ${c.exp - now}s out — the TTL cap is 3600`);
});
