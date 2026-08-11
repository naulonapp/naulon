/**
 * THE BYTES MUST BE IN HAND BEFORE THE MONEY MOVES.
 *
 * The paid path fetches the origin BEFORE settling so money never moves for a read the origin will
 * not deliver (`unservableRead.test.ts`). But "fetched" only ever meant "the headers arrived":
 * `proxyToOrigin` returns a STREAMING Response, and an article origin answers chunked (no
 * content-length), so the body is not necessarily buffered when those headers resolve. The gate
 * then held that unread stream across `settleAndAttribute` — an on-chain settle, ~1s and sometimes
 * several — and only the client, on the far side, ever tried to read it.
 *
 * If the upstream connection is recycled or closed inside that window, the body reads as ZERO
 * BYTES. The payment has already settled and the license has already minted, so the buyer gets
 * `200`, a real `settlementRef`, a signed license, and nothing to read. Measured on the local rig
 * 2026-08-11: roughly 40% of paid reads came back `ok=true, license=true, contentLen=0`, and the
 * agent above it cited an empty source as though it had read one.
 *
 * So the ordering guarantee has to be real: materialize the body, THEN settle. A body that fails
 * to read is then just another origin that could not deliver — refused, and never charged.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "naulon-paid-body-"));
process.env.EVENTS_PATH = join(dir, "events.jsonl");
process.env.OBSERVATIONS_PATH = join(dir, "observations.jsonl");
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");
const { usdc, walletAddress } = await import("@naulon/shared");
// From `enforce`, NOT `shared` — destructuring it off the wrong module yields `undefined`, and
// `headers.get(undefined)` returns null, which makes the "was it charged?" assertion below pass
// against a gate that charged. tsc caught exactly that.
const { CRAWLER_CHARGED_HEADER } = await import("@naulon/enforce");
type PublisherConfig = import("@naulon/shared").PublisherConfig;
type PublisherResolver = import("@naulon/shared").PublisherResolver;

const AUTHOR = walletAddress("0x0000000000000000000000000000000000000001");
const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT = { host: "materialize.example", "user-agent": "GPTBot/1.0" };
const ARTICLE = "# paid article\n\nthe bytes the buyer paid for.";

const PUB: PublisherConfig = {
  id: "materialize",
  originUrl: "http://origin-materialize.local",
  articlePrefixes: ["essays"],
  price: usdc(0.001),
  citationMultiplier: 5,
  credits: {
    async resolve(slug: string) {
      return { slug, title: `Test: ${slug}`, contributors: [{ authorId: "a1", wallet: AUTHOR }] };
    },
  },
  licenseIdentity: "naulon:materialize.example",
};
const app = createApp({
  async resolve(host) {
    return host === "materialize.example" ? PUB : undefined;
  },
} satisfies PublisherResolver);

/** How the fake origin's body behaves once the gate starts reading it. */
let bodyMode: "ok" | "dies-after-headers" = "ok";
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    // CHUNKED, exactly like a real article origin: a ReadableStream and no content-length, so the
    // runtime has not buffered anything by the time these headers resolve. That is the whole
    // precondition — a content-length'd body would be eagerly buffered and could never show this.
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (bodyMode === "dies-after-headers") {
          // The upstream socket went away between the headers and the read — a recycled keep-alive
          // connection, an origin restart, an idle timeout. Routine, not exotic.
          c.error(new Error("socket hang up"));
          return;
        }
        c.enqueue(new TextEncoder().encode(ARTICLE));
        c.close();
      },
    });
    // The hop-by-hop headers a REAL origin response carries, exactly as undici exposes them on a
    // `fetch` Response. They matter because the gate re-wraps the body: replaying chunked framing
    // over a fixed buffer produces a response that contradicts itself on the wire.
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/markdown",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
      },
    });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Quote a path, then pay it correctly. */
async function quoteThenPay(path: string): Promise<Response> {
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

test("an origin body that dies after the headers is NOT charged for", async () => {
  bodyMode = "dies-after-headers";
  const res = await quoteThenPay("/essays/vanishing-body");

  // The precise failure this guards: 200 + a charge + an empty body. Charging for zero bytes is
  // worse than refusing, because the buyer cannot tell the difference from a genuinely empty page.
  assert.notEqual(res.status, 200, "a body the gate could not read must not be sold as a paid read");
  assert.equal(res.headers.get(CRAWLER_CHARGED_HEADER), null, "nothing was delivered, so nothing may be charged");
});

test("the happy path still serves the origin's bytes in full", async () => {
  // The control. Without it, the assertion above would pass on a gate that refused EVERY paid read.
  bodyMode = "ok";
  const res = await quoteThenPay("/essays/real-body");

  assert.equal(res.status, 200, "a correctly paid read must be served");
  assert.equal(await res.text(), ARTICLE, "the buyer gets exactly the origin's bytes");
});

test("the served response does not replay the origin's connection framing", async () => {
  // The bug this catches cost a live run: the re-wrapped response kept the origin's
  // `transfer-encoding: chunked` while carrying a fixed in-memory buffer, so a real listener emitted
  // contradictory framing and every paid read died client-side as a bare "fetch failed". An
  // in-process `app.request()` never crosses a socket and cannot observe that, so it is asserted on
  // the headers directly — the one place the lie is visible from here.
  bodyMode = "ok";
  const res = await quoteThenPay("/essays/framing");

  assert.equal(res.status, 200);
  for (const hop of ["transfer-encoding", "connection", "keep-alive"]) {
    assert.equal(res.headers.get(hop), null, `${hop} describes the ORIGIN's connection and must not be replayed`);
  }
});
