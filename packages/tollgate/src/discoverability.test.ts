/**
 * Toll discoverability: the `/.well-known/x402` manifest and the `Link:
 * rel="payment"` header on a 402. The manifest must advertise the terms an agent
 * needs to pay — without ever naming an author wallet (payTo is per-article).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-discover-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { buildX402Manifest, PAYMENT_LINK_HEADER, build402, totalChargedMicro, quote: priceQuote } = await import("@naulon/enforce");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** A fixture publisher — the manifest never calls credits, so a no-op resolves. */
function fixturePublisher(): PublisherConfig {
  return {
    id: "test",
    originUrl: "http://origin.test",
    articlePrefixes: ["essays", "articles"],
    price: usdc(0.002),
    citationMultiplier: 5,
    credits: { resolve: async () => undefined },
    licenseIdentity: "naulon:test.host",
  };
}

test("buildX402Manifest derives both price legs from the publisher", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.payment.price.read.usdc, 0.002);
  assert.equal(m.payment.price.read.atomic, "2000");
  assert.equal(m.payment.price.citation.usdc, 0.01); // 0.002 * 5
  assert.equal(m.payment.price.citation.atomic, "10000");
  assert.equal(m.payment.price.citation.multiplier, 5);
  assert.equal(m.payment.currency, "USDC");
  assert.equal(m.payment.network, "eip155:5042002");
  assert.equal(m.humansReadFree, true);
  assert.deepEqual(m.resources.pathPrefixes, ["essays", "articles"]);
  assert.equal(m.license.identity, "naulon:test.host");
});

/**
 * A 10% fee with a floor, the shape the naulon control plane declares. Deliberately NOT
 * proportional: a floor is what makes a citation total something other than a read total times
 * the multiplier, and it is the case a manifest that scaled one figure would get wrong.
 */
function feeLegs(bps: number, floorMicro = 0): NonNullable<PublisherConfig["extraLegs"]> {
  return (price) => {
    const atomic = BigInt(Math.round((price as number) * 1_000_000));
    let amount = (atomic * BigInt(bps)) / 10_000n;
    if (amount < BigInt(floorMicro)) amount = BigInt(floorMicro);
    return amount > 0n
      ? [{ role: "operator" as const, payTo: walletAddress("0x00000000000000000000000000000000000fee01"), amount: amount.toString() }]
      : [];
  };
}

test("a publisher with no extra leg declares no total, byte-identical to before the field", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.payment.price.read.buyerTotal, undefined, "nothing to add, so nothing is said");
  assert.equal(m.payment.price.citation.buyerTotal, undefined);
});

test("a secondary leg is declared as the TOTAL, beside the leg the 402 carries", () => {
  const m = buildX402Manifest({ ...fixturePublisher(), extraLegs: feeLegs(1000) });
  // The leg keeps naming one transfer: `accepts[0]` on the 402 carries exactly this.
  assert.equal(m.payment.price.read.usdc, 0.002);
  assert.equal(m.payment.price.read.atomic, "2000");
  // And the total the buyer must authorize across every leg.
  assert.equal(m.payment.price.read.buyerTotal?.atomic, "2200");
  assert.equal(m.payment.price.read.buyerTotal?.usdc, 0.0022);
  assert.equal(m.payment.price.citation.buyerTotal?.atomic, "11000");
  assert.equal(m.payment.price.citation.buyerTotal?.usdc, 0.011);
});

test("the total is computed per amount, not scaled from the read", () => {
  // A floor of 1000 micro bites the read (200 -> 1000) and not the citation (1000 -> 1000).
  const m = buildX402Manifest({ ...fixturePublisher(), extraLegs: feeLegs(1000, 1000) });
  assert.equal(m.payment.price.read.buyerTotal?.atomic, "3000", "2000 + the floor");
  assert.equal(m.payment.price.citation.buyerTotal?.atomic, "11000", "10000 + the percentage");
  // Scaling the read total by the multiplier would have said 15000. That is the bug this shape
  // exists to make impossible.
  assert.notEqual(m.payment.price.citation.buyerTotal?.atomic, "15000");
});

/**
 * A publisher's fee hook is third-party code on a public, unauthenticated route. The SDK that
 * consumes this document resolves a failed fetch to null and then serves the read FREE, so a hook
 * defect must never be able to take the document down.
 */
test("a fee hook that throws costs the total, not the document", () => {
  const m = buildX402Manifest({
    ...fixturePublisher(),
    extraLegs: () => {
      throw new Error("resolver unavailable");
    },
  });
  assert.equal(m.payment.price.read.usdc, 0.002, "the document still serves");
  assert.equal(m.payment.price.read.buyerTotal, undefined, "and says nothing it cannot stand behind");
});

test("a malformed leg amount is refused rather than silently reinterpreted", () => {
  // A bare `BigInt("0x10")` is 16. Summing through the wire parser makes it a named error, and
  // this document degrades to silence instead of advertising a total nobody will charge.
  for (const amount of ["0x10", "1.5", "1e3"]) {
    const m = buildX402Manifest({
      ...fixturePublisher(),
      extraLegs: () => [{ role: "operator" as const, payTo: walletAddress(`0x${"f".repeat(40)}`), amount }],
    });
    assert.equal(m.payment.price.read.buyerTotal, undefined, `${amount} must not reach buyerTotal`);
  }
});

test("a total at or below the leg is never published", () => {
  // `PayoutLeg` is additive by contract. A negative would make buyerTotal LESS than atomic, which
  // under-funds a buyer who trusted it — this field's own failure, mirrored.
  const m = buildX402Manifest({
    ...fixturePublisher(),
    extraLegs: () => [{ role: "operator" as const, payTo: walletAddress(`0x${"f".repeat(40)}`), amount: "-500" }],
  });
  assert.equal(m.payment.price.read.buyerTotal, undefined);
});

test("every per-path rule carries its own total", () => {
  const m = buildX402Manifest({
    ...fixturePublisher(),
    priceRules: [{ pattern: "/papers/*", priceUsdc: 0.05 }],
    extraLegs: feeLegs(1000),
  });
  const rule = m.payment.price.rules?.[0];
  assert.equal(rule?.read.atomic, "50000");
  assert.equal(rule?.read.buyerTotal?.atomic, "55000");
  assert.equal(rule?.citation.buyerTotal?.atomic, "275000", "the rule price, its multiplier, then the fee");
});

/**
 * The tripwire the arithmetic tests cannot be: this document exists to agree with the 402, and
 * agreement is what nothing held before. The manifest sums the publisher's legs itself, `build402`
 * assembles the wire from the same hook, and until this test they could drift apart silently.
 *
 * Driven through the REAL quote and the REAL builder rather than a hand-made leg list, so a change
 * to either side has to keep them equal.
 */
test("the manifest's buyerTotal equals what the 402 actually asks for", async () => {
  const publisher = {
    ...fixturePublisher(),
    extraLegs: feeLegs(1000, 1000),
    credits: {
      resolve: async (slug: string) => ({
        slug,
        title: "X",
        contributors: [{ authorId: "a", wallet: walletAddress(`0x${"a".repeat(40)}`) }],
      }),
    },
  } satisfies PublisherConfig;

  for (const kind of ["read", "citation"] as const) {
    const q = await priceQuote(publisher, "essays/x", kind, "/essays/x");
    assert.ok(q, `no quote for ${kind}`);
    const built = build402(q, "https://origin.test/essays/x", Date.now());
    const m = buildX402Manifest(publisher);
    const declared = m.payment.price[kind].buyerTotal?.atomic ?? m.payment.price[kind].atomic;
    assert.equal(
      declared,
      totalChargedMicro(built.legs).toString(),
      `the ${kind} figure this document advertises is not the ask the 402 carries`,
    );
  }
});

test("buildX402Manifest advertises catalogUrl when the publisher sets one", () => {
  const m = buildX402Manifest({ ...fixturePublisher(), catalogUrl: "https://example.com/api/catalog" });
  assert.deepEqual(m.catalog, { url: "https://example.com/api/catalog" });
});

test("buildX402Manifest omits catalog when unset", () => {
  assert.equal(buildX402Manifest(fixturePublisher()).catalog, undefined);
});

/* ── per-path price rules in discovery (2026-09-07) ──────────────────────────────────────────────
 * The manifest is the pre-flight budget an agent authorizes against. It read `publisher.price`
 * directly, so a publisher who priced a section published the SITE base for it — measured on a live
 * gate: a manifest declaring `0.03` while the 402 under that section carried
 * `crawler-price: USD 0.10`. An agent that trusts discovery under-authorizes and its payment fails.
 * The same class as the `maxTimeoutSeconds` drift this file's own comment records. */

test("buildX402Manifest declares each price rule, at the amount the toll will charge", () => {
  const m = buildX402Manifest({
    ...fixturePublisher(),
    priceRules: [{ pattern: "/essays/premium", priceUsdc: 0.1 }, { pattern: "/essays", priceUsdc: 0.02 }],
  });
  assert.equal(m.payment.price.read.usdc, 0.002, "the base is still the base");
  assert.deepEqual(
    m.payment.price.rules?.map((r) => [r.pattern, r.read.usdc, r.read.atomic, r.citation.usdc]),
    [
      ["/essays/premium", 0.1, "100000", 0.5],
      ["/essays", 0.02, "20000", 0.1],
    ],
    "in the publisher's own resolution order, most specific first, with the citation legs priced up",
  );
});

test("a rule naming only a multiplier keeps the base read price and says which multiplier applies", () => {
  const m = buildX402Manifest({
    ...fixturePublisher(),
    priceRules: [{ pattern: "/essays", citationMultiplier: 20 }],
  });
  const rule = m.payment.price.rules?.[0];
  assert.equal(rule?.read.usdc, 0.002, "the rule moved the multiplier, not the read price");
  assert.equal(rule?.citation.usdc, 0.04);
  assert.equal(rule?.citation.multiplier, 20);
});

test("no rules ⇒ the manifest is byte-identical to before the field existed", () => {
  const withEmpty = buildX402Manifest({ ...fixturePublisher(), priceRules: [] });
  assert.equal(withEmpty.payment.price.rules, undefined);
  assert.deepEqual(withEmpty, buildX402Manifest(fixturePublisher()));
});

test("manifest never names an author wallet (payTo is a per-article policy)", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(m.payment.payTo), "payTo describes derivation, lists no wallet");
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(JSON.stringify(m.resources)), "no wallet anywhere in resources");
});

test("GET /.well-known/x402 serves the manifest for the served host", async () => {
  const res = await app.request("/.well-known/x402");
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReturnType<typeof buildX402Manifest>;
  assert.equal(body.x402Version, 2);
  assert.equal(body.humansReadFree, true);
  assert.ok(body.payment.price.read.atomic.length > 0);
});

test("a 402 carries the Link: rel=payment pointer to the manifest", async () => {
  const res = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("Link"), PAYMENT_LINK_HEADER);
  assert.match(res.headers.get("Link") ?? "", /\/\.well-known\/x402>;\s*rel="payment"/);
});

test("a human request is not tolled and gets no payment Link", async () => {
  const res = await app.request("/essays/on-stillness", {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  assert.notEqual(res.status, 402);
  assert.equal(res.headers.get("Link"), null);
});

// ── the manifest must describe the scope and chain actually in force ─────────────
// Both of these advertised the DEFAULT rather than the tenant's own setting, so the one
// document an agent reads before paying disagreed with the 402 it then received.

test("a site-scoped publisher advertises site scope, not a prefix list that understates it", () => {
  // The reference publisher's shape: gate_scope {mode:"site"} with a vestigial
  // articlePrefixes:["articles"] left over from prefix mode. Printing that list told an
  // agent four-fifths of the site was free to crawl, when none of it was.
  const m = buildX402Manifest({
    ...fixturePublisher(),
    gateScope: { mode: "site", excludePrefixes: ["api", "auth"] },
  });
  assert.equal(m.resources.scope, "site");
  assert.deepEqual(m.resources.excludePrefixes, ["api", "auth"]);
  assert.equal(m.resources.pathPrefixes, undefined, "absent is honest; a wrong list is not");
  assert.match(m.resources.note, /Every path/);
});

test("a prefix-scoped publisher is unchanged, and says so explicitly", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.resources.scope, "prefixes");
  assert.deepEqual(m.resources.pathPrefixes, ["essays", "articles"]);
  assert.equal(m.resources.excludePrefixes, undefined);
});

test("the manifest's chain follows the TENANT's settlementNetwork", async () => {
  const { getNetwork } = await import("@naulon/shared");
  const m = buildX402Manifest({ ...fixturePublisher(), settlementNetwork: "base" }, getNetwork("base"));
  assert.equal(m.payment.network, "eip155:8453");
  assert.equal(m.payment.chainId, 8453);
  assert.equal(m.payment.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
});

// ── The proof link, discoverable ──────────────────────────────────────────────
// A non-SDK buyer reads the manifest to learn the gate's shape. `license.verify` told it where
// an event could be looked up; it said nothing about the permanent record or the page a reader
// opens, so a buyer building its own citation block had to know both from documentation.
test("the manifest advertises the record route and the proof page, host pre-filled", () => {
  const m = buildX402Manifest(fixturePublisher());
  assert.equal(m.license.record, "/licenses/{jti}/record");
  assert.equal(m.license.proof, "https://naulon.app/verify?host=test.host&jti={jti}");
});

test("the proof template follows VERIFY_PAGE_URL, and keeps a query the page already carries", async () => {
  const { resetConfig } = await import("@naulon/shared");
  const prev = process.env.VERIFY_PAGE_URL;
  process.env.VERIFY_PAGE_URL = "https://self.host/check?lang=de";
  resetConfig();
  try {
    const m = buildX402Manifest(fixturePublisher());
    assert.equal(m.license.proof, "https://self.host/check?lang=de&host=test.host&jti={jti}");
  } finally {
    if (prev === undefined) delete process.env.VERIFY_PAGE_URL;
    else process.env.VERIFY_PAGE_URL = prev;
    resetConfig();
  }
});

test("a site whose terms give ai-input away advertises no price", () => {
  const m = buildX402Manifest({
    ...fixturePublisher(),
    termsPolicy: { "ai-input": "free" },
    extraLegs: feeLegs(1000),
    priceRules: [{ pattern: "/essays/*", priceUsdc: 0.1 }],
  });
  assert.equal(m.agentReads, "free");
  assert.equal(m.payment.price.read.atomic, "0");
  assert.equal(m.payment.price.citation.atomic, "0");
  assert.equal(m.payment.price.read.buyerTotal, undefined);
  assert.equal(m.payment.price.rules, undefined);
});

test("a manifest without stated terms carries no agentReads field", () => {
  assert.equal("agentReads" in buildX402Manifest(fixturePublisher()), false);
  assert.equal(buildX402Manifest({ ...fixturePublisher(), termsPolicy: { "ai-input": "prohibit" } }).agentReads, "refused");
});
