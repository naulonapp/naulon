/**
 * The permanent record of a SALE must say what was sold.
 *
 * W6 made the citation record a second projection of the same ledger row as the access licence.
 * W8 then sold scopes — and the row carried no scope, terms, period or subject, so the projection
 * that matters most (permanent, public, checkable without asking naulon) could name the payment
 * and nothing about what it bought. These tests pin the projection in both directions: a sale's
 * facts survive to the record, and a toll's record states exactly what its access licence states.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const EVENTS = join(tmpdir(), `naulon-record-scope-${process.pid}.jsonl`);
process.env.EVENTS_PATH = EVENTS;
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";
await writeFile(EVENTS, "");

const { app } = await import("./app.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type LicenceFacts = import("@naulon/shared").LicenceFacts;

function payload(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Append a settled event straight to the ledger — the same shape the settle tail writes. */
async function seed(licence?: LicenceFacts, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await appendFile(
    EVENTS,
    JSON.stringify({
      id,
      slug: "scope:/essays/*",
      kind: "read",
      amount: usdc(0.03),
      payees: [{ authorId: "ann", wallet: walletAddress("0x1111111111111111111111111111111111111111"), share: 1 }],
      payerAddress: walletAddress("0x2222222222222222222222222222222222222222"),
      settlementRef: "mock-ref",
      ...(licence ? { licence } : {}),
      ...extra,
      at: Date.now(),
    }) + "\n",
  );
  return id;
}

async function recordFor(jti: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/licenses/${jti}/record`);
  assert.equal(res.status, 200, `expected a record for ${jti}`);
  const body = (await res.json()) as { record: string };
  return payload(body.record);
}

test("a sale's record carries the scope, terms, period and subject the row stored", async () => {
  const period = { from: 1_780_000_000, until: 1_780_000_000 + 30 * 86_400 };
  const facts: LicenceFacts = {
    scope: { patterns: ["/essays/a$", "/essays/b$"] },
    terms: ["ai-input", "search"],
    period,
    subject: "acct:33333333-3333-4333-8333-333333333333",
  };
  const claims = await recordFor(await seed(facts));
  const n = claims.naulon as Record<string, unknown>;

  assert.deepEqual(n.scope, facts.scope, "a stranger must be able to read WHAT was licensed");
  assert.deepEqual(n.terms, facts.terms);
  assert.deepEqual(n.period, period);
  assert.equal(claims.sub, facts.subject, "the record names the buyer, not the payer wallet");
  // Still the permanent object: it grants nothing, so it needs no expiry and no revocation.
  assert.equal(n.grant, "none");
  assert.equal("exp" in claims, false);
});

test("a toll's record states the toll's terms, and no scope, period or subject", async () => {
  // The access licence a toll mints states `ai-input` (settle.ts, DEFAULT_TOLL_TERMS). The record
  // is the same row's other projection, so it must say the same thing: a permanent proof that
  // omits the rights its own access token granted is a record of less than was sold.
  const claims = await recordFor(await seed());
  const n = claims.naulon as Record<string, unknown>;
  assert.deepEqual(n.terms, ["ai-input"]);
  assert.equal(n.scope, undefined);
  assert.equal(n.period, undefined);
  assert.equal(String(claims.sub).toLowerCase(), "0x2222222222222222222222222222222222222222");
});

test("the record names the work by title, and falls back to the slug on an older row", async () => {
  const titled = await recordFor(await seed(undefined, { title: "On Passage" }));
  assert.equal((titled.naulon as Record<string, unknown>).title, "On Passage");
  const untitled = await recordFor(await seed());
  assert.equal((untitled.naulon as Record<string, unknown>).title, "scope:/essays/*");
});

test("the record carries the resource, the content hash, the terms document and the buyer's evidence", async () => {
  const evidence = {
    scheme: "eip3009",
    domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002, verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9" },
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: "0x1111111111111111111111111111111111111111",
      value: "30000",
      validAfter: "0",
      validBefore: "1790000000",
      nonce: "0x" + "ab".repeat(32),
    },
    signature: "0x" + "cd".repeat(65),
  };
  const termsDocument = { url: "https://example.com/license.xml", sha256: "ef".repeat(32) };
  const claims = await recordFor(
    await seed(undefined, { resource: "https://example.com/essays/a", contentSha256: "12".repeat(32), termsDocument, evidence }),
  );
  const n = claims.naulon as Record<string, unknown>;
  assert.equal(n.resource, "https://example.com/essays/a");
  assert.equal(n.contentSha256, "12".repeat(32));
  assert.deepEqual(n.termsDocument, termsDocument);
  assert.deepEqual(n.evidence, evidence);
});

test("the record is byte-stable: issued at the sale, not at the fetch", async () => {
  const jti = await seed();
  const a = await app.request(`/licenses/${jti}/record`);
  await new Promise((r) => setTimeout(r, 1100)); // across a second boundary, where a fetch-time iat would move
  const b = await app.request(`/licenses/${jti}/record`);
  const ra = ((await a.json()) as { record: string }).record;
  const rb = ((await b.json()) as { record: string }).record;
  assert.equal(ra, rb, "a saved copy and a later fetch must compare equal");
});

test("the record's period survives a scope that the ACCESS licence could never outlive", async () => {
  // The point of the two objects: a 30-day purchase cannot be a 30-day access token (the TTL is
  // an unrevocable credential's only kill switch), but the RECORD of that purchase is permanent
  // and must state the full period a buyer paid for.
  const from = 1_780_000_000;
  const until = from + 365 * 86_400;
  const claims = await recordFor(await seed({ period: { from, until } }));
  assert.deepEqual((claims.naulon as Record<string, unknown>).period, { from, until });
  assert.equal("exp" in claims, false);
});
