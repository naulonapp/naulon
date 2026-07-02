/**
 * The audit plane, end to end through the gate: a human read, an agent denied at
 * the 402, and an agent that pays each leave the right ObservationEvent in the
 * ledger — the "who was served free / denied / paid" the settlement ledger can't
 * see. Env is set BEFORE importing the app so the observation sink binds to a tmp
 * jsonl file (the default is OFF / no-op).
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationEvent } from "@naulon/shared";

const OBS_PATH = join(tmpdir(), `naulon-obs-${process.pid}.jsonl`);
process.env.OBSERVATIONS_BACKEND = "jsonl";
process.env.OBSERVATIONS_PATH = OBS_PATH;
process.env.EVENTS_PATH = join(tmpdir(), `naulon-obs-events-${process.pid}.jsonl`);
process.env.PAYMENT_MODE = "mock";
process.env.LICENSES_ENABLED = "true";
process.env.RATE_LIMIT_RPM = "0";

const { app } = await import("./app.ts");
const { buildMockSignature, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } = await import("./x402.ts");

const PAYER = "0x1234567890abcdef1234567890abcdef12345678";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () =>
    new Response("<html>origin</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

function decodeJson(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

/** observe() is fire-and-forget, so the append can lag the response — poll the file. */
async function waitForObs(predicate: (all: ObservationEvent[]) => boolean): Promise<ObservationEvent[]> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(OBS_PATH, "utf8");
      const all = raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ObservationEvent);
      if (predicate(all)) return all;
    } catch {
      /* ENOENT until the first write — keep polling */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for observations");
}

test("a human read, an agent denial, and an agent payment each emit the right observation", async () => {
  // 1) Human — read free.
  const human = await app.request("/essays/on-stillness", { headers: { "user-agent": BROWSER_UA } });
  assert.equal(human.status, 200, "human reads free");

  // 2) Agent, no payment — denied at the 402.
  const denied = await app.request("/essays/on-stillness", { headers: { "x-naulon-agent": "tester" } });
  assert.equal(denied.status, 402, "unpaid agent is denied");

  // 3) Agent pays — full handshake.
  const required = denied.headers.get(PAYMENT_REQUIRED_HEADER)!;
  const accepts = (decodeJson(required).accepts as Array<{ amount: string; extra: { nonce: string } }>)[0]!;
  const sig = buildMockSignature(PAYER, accepts.amount, accepts.extra.nonce);
  const paid = await app.request("/essays/on-stillness", {
    headers: { "x-naulon-agent": "tester", [PAYMENT_SIGNATURE_HEADER]: sig },
  });
  assert.equal(paid.status, 200, "paid agent gets content");

  // The paid observation is emitted last; wait until it lands.
  const all = await waitForObs((obs) => obs.some((o) => o.verdict === "paid"));

  const free = all.find((o) => o.verdict === "served-free");
  const den = all.find((o) => o.verdict === "denied");
  const pay = all.find((o) => o.verdict === "paid");

  assert.ok(free, "a served-free observation for the human");
  assert.equal(free!.classifiedAs, "human");
  assert.equal(free!.slug, "on-stillness");

  assert.ok(den, "a denied observation for the unpaid agent");
  assert.equal(den!.classifiedAs, "agent");
  assert.equal(den!.kind, "read");
  assert.ok(typeof den!.price === "number" && den!.price > 0, "denied carries the price they'd have paid");

  assert.ok(pay, "a paid observation for the settled agent");
  assert.equal(pay!.classifiedAs, "agent");
  assert.ok(typeof pay!.price === "number" && pay!.price > 0, "paid carries the settled price");
});

test("observations are scoped to the resolved publisher (publisherId stamped)", async () => {
  const all = await waitForObs((obs) => obs.length > 0);
  // The default env resolver stamps a single publisher id on every observation —
  // the seam a multi-tenant deploy reads to isolate one tenant's audit feed.
  for (const o of all) {
    assert.ok(typeof o.publisherId === "string" && o.publisherId.length > 0, "every observation is attributed");
  }
});
