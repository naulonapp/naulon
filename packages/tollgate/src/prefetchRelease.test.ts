/**
 * A PREFETCHED BODY MUST NEVER BE LEFT DANGLING.
 *
 * The paid path fetches the origin BEFORE settling, so money never moves for a read the origin will
 * not deliver (see `unservableRead.test.ts`). The hazard that creates: an unread undici body holds
 * its socket out of the connection pool until GC finalises it, so a run of failing payments leaks
 * one connection each — against the publisher's own origin, which is the thing this gate exists to
 * shield. Nothing fails, nothing logs; the pool just quietly narrows.
 *
 * HOW THIS IS SATISFIED CHANGED (2026-08-11). It used to be a `body.cancel()` on the one branch that
 * fetches and then does not serve — settle FAILS after a 2xx prefetch. The gate now DRAINS the body
 * into memory the moment it arrives, before settling at all (`materializeBody`), because holding an
 * unread chunked stream across an on-chain settle was returning ZERO-BYTE bodies to buyers who had
 * already paid (`paidBodyMaterialized.test.ts`). Draining subsumes the release: a fully-read body
 * has already returned its socket to the pool, on every branch, including this one.
 *
 * So the invariant is unchanged and the assertion moved with the mechanism: after a failed settle,
 * the origin's body must have been consumed to completion, not abandoned.
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
const BODY = "<html>origin</html>";

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

/** Set by the fake origin's body once the gate has read it to EOF — i.e. the socket is reusable. */
let drained = false;
/** Set if the gate abandons the body by cancelling it instead of reading it. */
let cancelled = false;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    drained = false;
    cancelled = false;
    // Chunked and finite, like a real origin: enqueue, then close. The previous fixture deliberately
    // never closed, which was only safe while nobody read the body here — now that the gate drains
    // it up front, a body with no EOF is an origin stall, and that case has its own coverage in
    // `paidBodyMaterialized.test.ts`.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(BODY));
        c.close();
        drained = true;
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

test("a settle failure does not leave the prefetched origin body dangling", async () => {
  const res = await quoteThenPay("/essays/release-me", true);

  assert.equal(res.status, 402, "an underpaid settle must refuse, not serve");
  assert.equal(drained, true, "the origin body was abandoned unread — that is the socket leak");
  assert.equal(cancelled, false, "it should be consumed, not cancelled — draining is what frees the socket");
});

test("the happy path serves those same bytes", async () => {
  // The control. Without it, the assertion above would pass on a gate that refused every paid read.
  const res = await quoteThenPay("/essays/serve-me", false);

  assert.equal(res.status, 200, "a correctly paid read must be served");
  // `.text()` now terminates, which is itself the fix: the body reaching the buyer is a finite
  // in-memory buffer, not a stream still owned by the upstream socket.
  assert.equal(await res.text(), BODY, "the served body is the origin's");
});
