/**
 * The permanent record of a SALE must say what was sold.
 *
 * W6 made the citation record a second projection of the same ledger row as the access licence.
 * W8 then sold scopes — and the row carried no scope, terms, period or subject, so the projection
 * that matters most (permanent, public, checkable without asking naulon) could name the payment
 * and nothing about what it bought. These tests pin the projection in both directions: a sale's
 * facts survive to the record, and a toll's record is unchanged.
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
async function seed(licence?: LicenceFacts): Promise<string> {
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

test("a toll's record is unchanged — no scope, no terms, no period, sub = the payer", async () => {
  const claims = await recordFor(await seed());
  const n = claims.naulon as Record<string, unknown>;
  assert.equal(n.scope, undefined);
  assert.equal(n.terms, undefined);
  assert.equal(n.period, undefined);
  assert.equal(String(claims.sub).toLowerCase(), "0x2222222222222222222222222222222222222222");
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
