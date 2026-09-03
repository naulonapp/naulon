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
    now: Date.now(),
    expectedIssuer: "https://example.test",
    expectedAudience: "https://example.test",
    jwks: licensing!.jwks,
  });
  assert.equal(verified.ok, true, `licence did not verify: ${JSON.stringify(verified)}`);
  if (!verified.ok) throw new Error("unreachable");
  return verified.claims;
}

test("a toll mints exactly what it always did — no scope, no terms, no period, sub = the payer", async () => {
  const c = await claimsOf(await settleAndAttribute(args(Date.now())));
  assert.equal(c.naulon.scope, undefined);
  assert.equal(c.naulon.terms, undefined);
  assert.equal(c.naulon.period, undefined);
  assert.equal(c.naulon.grant, undefined, "absent grant is what makes an old verifier read it as a read");
  assert.equal(c.sub.toLowerCase(), PAYER.toLowerCase());
  assert.equal(licenseGrant(c.naulon as never), "read");
});

test("a sale carries the scope, terms, period and subject through to the claim", async () => {
  const now = Date.now();
  // The PERIOD is epoch seconds — the unit the claim uses — while `now` is milliseconds.
  const nowSec = Math.floor(now / 1000);
  const period = { from: nowSec, until: nowSec + 30 * 86_400 };
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
  const now = Date.now();
  const res = await settleAndAttribute(args(now));
  assert.equal(res.ok, true);
  assert.ok(res.eventId, "expected the event id back");
  const c = await claimsOf(res);
  assert.equal(c.jti, res.eventId);
});

test("a sale's purchased PERIOD is not its re-read window — exp stays the TTL", async () => {
  // The whole reason period is a separate field: a 30-day licence must not become a 30-day
  // bearer token. `exp` is the kill switch and stays capped at the TTL.
  const now = Date.now();
  const c = await claimsOf(
    await settleAndAttribute(
      args(now, {
        scope: { patterns: ["/essays/*"] },
        period: { from: Math.floor(now / 1000), until: Math.floor(now / 1000) + 30 * 86_400 },
      }),
    ),
  );
  // Compared against the SECONDS form of the same instant. The earlier version of this assertion
  // subtracted a millisecond `now` from a seconds `exp`, which is hugely negative and therefore
  // <= 3600 for any implementation at all — it passed while the clock unit was wrong.
  const nowSecCheck = Math.floor(now / 1000);
  assert.ok(c.exp !== undefined, "an access licence must still expire");
  assert.ok(c.exp > nowSecCheck, `exp ${c.exp} is not in the future of ${nowSecCheck}`);
  assert.ok(
    c.exp - nowSecCheck <= 3600,
    `exp is ${c.exp - nowSecCheck}s out — the TTL cap is 3600`,
  );
});

/**
 * The ledger row, not the token.
 *
 * The access licence and the citation record are two projections of ONE row, and only the token
 * is minted inside `settleAndAttribute`. The permanent record is minted later, from storage, by
 * `GET /licenses/:jti/record` — so any fact the row does not carry can never reach the object a
 * stranger actually verifies. That made a scope purchase's permanent proof able to name the
 * payment but not what was bought.
 */
async function rowFor(eventId: string): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(process.env.EVENTS_PATH!, "utf8")).trim().split("\n");
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.id === eventId) return row;
  }
  throw new Error(`no ledger row for ${eventId}`);
}

test("a sale's ledger row carries the licence facts, so the permanent record can project them", async () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const period = { from: nowSec, until: nowSec + 30 * 86_400 };
  const licence = {
    scope: { patterns: ["/essays/a$"] },
    terms: ["ai-input"] as const,
    period,
    subject: "acct:22222222-2222-4222-8222-222222222222",
  };
  const res = await settleAndAttribute(args(now, licence as never));
  assert.equal(res.ok, true);
  assert.deepEqual((await rowFor(res.eventId!)).licence, licence);
});

test("a TOLL's ledger row has no licence key at all — absent, not an empty object", async () => {
  // Millions of historical rows say nothing about a sale by having no such field. Writing `{}`
  // would be a new, different statement on every toll forever, for the sake of describing
  // nothing happening.
  const res = await settleAndAttribute(args(Date.now()));
  assert.equal(res.ok, true);
  assert.equal("licence" in (await rowFor(res.eventId!)), false);
});
