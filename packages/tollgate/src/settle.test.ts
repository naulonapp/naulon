/**
 * The settle tail stamps the HOST onto the attributed event.
 *
 * `AttributedEvent` has always carried `publisherId`, so the ledger could answer "has this
 * publisher been paid recently" — and never "has THIS host been paid recently". A publisher can
 * serve many hosts, and only the settle tail knows which one was tolled; nothing downstream can
 * recover it from a row that omitted it. A resolver-based deploy classifying enforcement per host
 * therefore had to attribute the whole tenant's traffic to every one of its hosts, which reads a
 * domain that has never been read once as actively earning.
 *
 * Driven through the real `settleAndAttribute` in `PAYMENT_MODE=mock` (the default) and read back
 * out of the ledger sink, so this covers the actual write rather than the shape of a literal.
 *
 * EVENTS_PATH is set before any getConfig() call (it caches on first read) — same discipline as
 * `eventsink.test.ts`. NODE_ENV=test skips dotenv, so what is set here is what config sees.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "naulon-settle-host-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.LICENSES_ENABLED = "false"; // no signing key needed — the event write is what's under test

const { resetConfig, usdc, walletAddress } = await import("@naulon/shared");
resetConfig();
const { settleAndAttribute } = await import("./settle.ts");
const { readAll } = await import("./eventLog.ts");
const { NETWORKS } = await import("@naulon/shared");
const { bindingOf, issueNonce } = await import("@naulon/enforce");

const PAYEE = walletAddress("0x1111111111111111111111111111111111111111");
const PAYER = "0x2222222222222222222222222222222222222222";

/** One author leg on the fleet's default testnet — mock mode never touches a facilitator. */
function authorLeg(): { role: "author"; requirements: Record<string, unknown> } {
  return {
    role: "author",
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

/** A mock payment payload: settleMock wants {payer, amount, nonce} per leg, and the nonce must be
 *  a real issued one — it is bound to (amount, payTo, network) and consumed once, exactly as a
 *  buyer's would be. Issuing it per call is what keeps each test a fresh, non-replayed payment. */
function payment(now: number): string {
  const nonce = issueNonce(bindingOf(authorLeg().requirements as never), now);
  return Buffer.from(JSON.stringify([{ payer: PAYER, amount: "5000", nonce }])).toString("base64");
}

function args(host: string, now: number): Parameters<typeof settleAndAttribute>[0] {
  return {
    payment: payment(now),
    legs: [authorLeg()] as never,
    quote: {
      slug: "on-stillness",
      title: "On Stillness",
      kind: "read",
      price: usdc(0.005),
      payees: [{ authorId: "a1", wallet: PAYEE, share: 1 }],
      extraLegs: [],
    } as never,
    publisher: {
      id: "pub-1",
      originUrl: "https://origin.example",
      articlePrefixes: ["articles"],
      price: usdc(0.005),
      citationMultiplier: 5,
      credits: { resolve: async () => null },
      licenseIdentity: "naulon:test",
    } as never,
    host,
    now,
  };
}

test("the settled event carries the host it was tolled on", async () => {
  const now = Date.now();
  const res = await settleAndAttribute(args("busy.example.com", now));
  assert.equal(res.ok, true, res.error);

  const events = await readAll("pub-1");
  const written = events.find((e) => e.slug === "on-stillness" && e.at === now);
  assert.ok(written, "the settle tail must have written a ledger row");
  assert.equal(written.host, "busy.example.com");
});

/* The reason the field exists at all: one publisher, two hosts, and a ledger that can tell them
 * apart. Without the stamp both rows are indistinguishable and the only question the ledger can
 * answer is about the publisher — which is what made a never-read domain look like it was earning. */
test("two hosts under one publisher are distinguishable in the ledger", async () => {
  const t0 = Date.now() + 1000;
  await settleAndAttribute(args("busy.example.com", t0));
  await settleAndAttribute(args("quiet.example.com", t0 + 1));

  const events = await readAll("pub-1");
  const hosts = events.filter((e) => e.at === t0 || e.at === t0 + 1).map((e) => e.host);
  assert.deepEqual(hosts.sort(), ["busy.example.com", "quiet.example.com"]);
});
