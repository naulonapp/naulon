/**
 * Fail-open error boundary: an unhandled fault on a route — a down origin, a
 * resolver/store blip — must surface as a branded 503, never a raw 500. A human
 * read must never become an error-page stack because something naulon-side broke.
 *
 * Env is set BEFORE importing the app so config binds mock mode + a tmp ledger,
 * matching publisher.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVENTS_PATH = join(tmpdir(), `naulon-failopen-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "false";
process.env.RATE_LIMIT_RPM = "0";

const { createApp } = await import("./app.ts");
type PublisherResolver = import("@naulon/shared").PublisherResolver;

// A resolver whose backing store is down — resolve() throws, the way a Supabase
// blip would propagate through a DB-backed resolver.
const throwingResolver: PublisherResolver = {
  async resolve() {
    throw new Error("store unavailable");
  },
};

test("a resolver/store fault yields a branded 503, not a raw 500", async () => {
  const app = createApp(throwingResolver);
  const res = await app.request("/essays/anything", { headers: { host: "a.example" } });
  assert.equal(res.status, 503, "a naulon-side fault must not 500 a caller");
  assert.equal(res.headers.get("retry-after"), "30");
  assert.match(await res.text(), /temporarily unavailable/i);
});
