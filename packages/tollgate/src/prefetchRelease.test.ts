/**
 * A PREFETCHED BODY WE DO NOT SERVE MUST BE RELEASED.
 *
 * The paid path fetches the origin BEFORE settling, so money never moves for a read the origin
 * will not deliver (see `unservableRead.test.ts`). That leaves exactly one branch that fetches and
 * then does not serve what it fetched: settle FAILS after a 2xx prefetch. There the gate returns a
 * fresh 402 and the origin's response simply falls out of scope.
 *
 * An unread undici body holds its socket out of the connection pool until GC finalises it, so a run
 * of failing payments leaks one connection each — against the publisher's own origin, which is the
 * thing this gate exists to shield. Nothing fails, nothing logs; the pool just quietly narrows.
 *
 * This asserts the release directly, by giving the fake origin a body whose `cancel()` is
 * observable. Asserting it any other way would mean asserting on a GC finaliser, which is not
 * testable.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naulon-prefetch-release-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.OBSERVATIONS_PATH = join(dir, "observations.jsonl");
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT = { host: "release.example", "user-agent": "GPTBot/1.0" };

const PUB: PublisherConfig = {
  id: "release",
  originUrl: "http://origin-release.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "a1", wallet: AUTHOR }] };
    },
  },
  licenseIdentity: "naulon:release.example",
};
const app = createApp({
  async resolve(host) {
    return host === "release.example" ? PUB : undefined;
  },
} satisfies PublisherResolver);

/** Set by the fake origin's body when the gate releases it. */
let cancelled = false;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html>origin</html>"));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Quote a path, then present `payment` (valid or not) against it. */
async function quoteThenPay(path: string, corrupt: boolean): Promise<Response> {
  const quoted = await app.request(path, { headers: { ...AGENT } });
  assert.equal(quoted.status, 402, "fixture must actually reach the paid path");
  const required = quoted.headers.get(PAYMENT_REQUIRED_HEADER)!;
  const accepts = (
    JSON.parse(Buffer.from(required, "base64").toString("utf8")).accepts as Array<{
      amount: string;
      extra: { nonce: string };
    }>
  )[0]!;
  // Corrupt by underpaying: the signature is well-formed, so it reaches settle and is REFUSED
  // there — which is the branch under test. A malformed header would be rejected earlier, before
  // anything is prefetched, and would prove nothing.
  const amount = corrupt ? "1" : accepts.amount;
  return app.request(path, {
    headers: { ...AGENT, [PAYMENT_SIGNATURE_HEADER]: buildMockSignature(PAYER, amount, accepts.extra.nonce) },
  });
}

test("a settle failure releases the prefetched origin body", async () => {
  const res = await quoteThenPay("/essays/release-me", true);

  assert.equal(res.status, 402, "an underpaid settle must refuse, not serve");
  assert.equal(cancelled, true, "the prefetched origin body was dropped without being released");
});

test("the happy path does NOT cancel it — the body is what gets served", async () => {
  // The control. Without it, `cancelled` could be true because the gate cancels EVERY prefetch,
  // which would mean the assertion above passes while the paid read returns nothing.
  const res = await quoteThenPay("/essays/serve-me", false);

  assert.equal(res.status, 200, "a correctly paid read must be served");

  // Read ONE chunk rather than `.text()`. The fake origin's stream is deliberately left open — a
  // closed stream's `cancel()` is a spec no-op that never reaches the underlying source, which
  // would make the test above unable to observe anything. So the body has no EOF to wait for, and
  // `.text()` would hang forever.
  const { value } = await res.body!.getReader().read();
  assert.equal(new TextDecoder().decode(value), "<html>origin</html>", "the served body is the origin's");
  assert.equal(cancelled, false, "the served body must not have been cancelled");
});
