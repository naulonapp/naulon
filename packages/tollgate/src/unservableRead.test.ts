/**
 * NEVER MOVE MONEY FOR A READ THE ORIGIN WILL NOT DELIVER.
 *
 * The gate settled first and proxied afterwards, so an origin that answered 404 left the buyer
 * charged with nothing to show for it — and custody-free means there is no refund path, because the
 * money went buyer → author directly.
 *
 * Found live 2026-08-04: `fleetorigin.naulon.app` had moved its articles to `.html` suffixes while
 * the catalog still declared the extensionless slugs. Slug extraction strips the suffix, so both
 * URLs priced and only one was servable — GPTBot was quoted 5000 micro-USDC on a URL the origin
 * could not serve. "GPTBot gets a 402", the fleet walk's own success criterion, passed throughout.
 *
 * These assert the ORDER, which is the whole fix: the ledger is the ground truth for "did money
 * move", so each case reads it back rather than trusting a header.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naulon-unservable-"));
const OBS = join(dir, "observations.jsonl");
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.OBSERVATIONS_PATH = OBS;
process.env.OBSERVATIONS_BACKEND = "jsonl"; // the real sink, so this covers the emit too
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { readAll } = await import("./eventLog.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;
type ObservationEvent = import("@naulon/shared").ObservationEvent;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT = { host: "servable.example", "user-agent": "GPTBot/1.0" };

const PUB: PublisherConfig = {
  id: "servable",
  originUrl: "http://origin-servable.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  // Prices every slug — exactly the real shape, where the catalog declares what the origin may or
  // may not still serve.
  credits: {
    async resolve(slug: string) {
      return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "a1", wallet: AUTHOR }] };
    },
  },
  licenseIdentity: "naulon:servable.example",
};
const resolver: PublisherResolver = {
  async resolve(host) {
    return host === "servable.example" ? PUB : undefined;
  },
};

const app = createApp(resolver);

/** Every observation the gate has written so far, read back off the real jsonl sink. */
function observations(): ObservationEvent[] {
  if (!existsSync(OBS)) return [];
  return readFileSync(OBS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ObservationEvent);
}

/**
 * Wait for the OUTCOME observation of this slug's pay handshake.
 *
 * Two things make the naive read wrong. `emitObs` is deliberately fire-and-forget — the audit write
 * must never block or fail the toll path — so the response returns before the sink has appended;
 * reading straight after is a race that passes by luck once an earlier test has flushed. And every
 * `pay()` writes TWO rows: the 402 quote (`denied`) then the outcome. So poll for the row that is
 * not the quote, rather than sleeping a guessed interval or taking the first match.
 */
async function outcomeFor(slug: string, timeoutMs = 2000): Promise<ObservationEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = observations().find((o) => o.slug === slug && o.verdict !== "denied");
    if (hit || Date.now() > deadline) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** What the fake origin answers next. */
let originStatus = 200;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response(originStatus === 200 ? "<html>origin</html>" : "not found", {
      status: originStatus,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** The full 402 → pay handshake against a given path. */
async function pay(path: string): Promise<Response> {
  const quoted = await app.request(path, { headers: { ...AGENT } });
  assert.equal(quoted.status, 402, "fixture must actually reach the paid path");
  const required = quoted.headers.get(PAYMENT_REQUIRED_HEADER)!;
  const accepts = (
    JSON.parse(Buffer.from(required, "base64").toString("utf8")).accepts as Array<{
      amount: string;
      extra: { nonce: string };
    }>
  )[0]!;
  return app.request(path, {
    headers: { ...AGENT, [PAYMENT_SIGNATURE_HEADER]: buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce) },
  });
}

test("an origin that cannot serve the read is never charged for", async () => {
  originStatus = 404;
  const before = (await readAll("servable")).length;

  const res = await pay("/essays/gone-from-the-origin");

  assert.equal(res.status, 404, "the buyer gets the origin's own status");
  assert.equal(
    (await readAll("servable")).length,
    before,
    "THE INVARIANT: no ledger row — money must not move for a read we cannot deliver",
  );
  assert.equal(res.headers.get("crawler-charged"), null, "a charge header would claim money moved");
  assert.match(res.headers.get("x-naulon-verdict") ?? "", /not charged/i);
});

test("the publisher can see it happened — verdict `unservable`, not a silent free read", async () => {
  originStatus = 404;
  await pay("/essays/also-gone");

  const v = await outcomeFor("also-gone");
  assert.equal(v?.verdict, "unservable");
  // The price is carried so the publisher can see what the failed sale was worth. It is the only
  // signal that a catalog entry is priced but unservable — the quote is well-formed, the buyer is
  // solvent, and every other surface reports the toll as working.
  assert.ok((v?.price ?? 0) > 0, "the forgone amount is recorded");
});

test("a servable read still settles and is still charged (no regression)", async () => {
  originStatus = 200;
  const before = (await readAll("servable")).length;

  const res = await pay("/essays/still-here");

  assert.equal(res.status, 200);
  assert.equal((await readAll("servable")).length, before + 1, "the happy path must still write its row");
  assert.ok(res.headers.get("crawler-charged"), "and still claim the charge");
  assert.equal((await outcomeFor("still-here"))?.verdict, "paid");
});

/* The buyer's authorization must survive a refused sale: we never called verifyAndSettle, so the
 * nonce was never consumed. If the gate had burned it, an agent whose read we declined would also
 * have lost the payment it had signed — punished twice for our catalog being wrong. */
test("a refused sale leaves the payment reusable — the nonce is not burned", async () => {
  originStatus = 404;
  const quoted = await app.request("/essays/reusable", { headers: { ...AGENT } });
  const accepts = (
    JSON.parse(Buffer.from(quoted.headers.get(PAYMENT_REQUIRED_HEADER)!, "base64").toString("utf8"))
      .accepts as Array<{ amount: string; extra: { nonce: string } }>
  )[0]!;
  const sig = buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce);

  const refused = await app.request("/essays/reusable", { headers: { ...AGENT, [PAYMENT_SIGNATURE_HEADER]: sig } });
  assert.equal(refused.status, 404);

  // Origin recovers; the SAME signed payment now completes.
  originStatus = 200;
  const retried = await app.request("/essays/reusable", { headers: { ...AGENT, [PAYMENT_SIGNATURE_HEADER]: sig } });
  assert.equal(retried.status, 200, "the untouched authorization must still settle");
  assert.ok(retried.headers.get("crawler-charged"));
});
