import assert from "node:assert/strict";
import { test } from "node:test";
import { usdc, type ObservationEvent, type ObservationVerdict } from "@naulon/shared";
import { summarizeOps } from "./ops.ts";

let seq = 0;
function obs(
  verdict: ObservationVerdict,
  classifiedAs: "human" | "agent",
  at: number,
  extra: Partial<ObservationEvent> = {},
): ObservationEvent {
  return {
    id: `o-${seq++}`,
    host: "example.com",
    slug: "an-essay",
    verdict,
    classifiedAs,
    at,
    ...extra,
  };
}

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

test("counts observations by verdict within the window", () => {
  const s = summarizeOps(
    [
      obs("served-free", "human", NOW - 10),
      obs("served-free", "human", NOW - 20),
      obs("denied", "agent", NOW - 30),
      obs("paid", "agent", NOW - 40, { price: usdc(0.005) }),
    ],
    NOW,
    HOUR,
  );
  assert.equal(s.total, 4);
  assert.equal(s.byVerdict["served-free"], 2);
  assert.equal(s.byVerdict["denied"], 1);
  assert.equal(s.byVerdict["paid"], 1);
});

test("earnings = sum of paid prices; missed = denied + payment-failed prices", () => {
  const s = summarizeOps(
    [
      obs("paid", "agent", NOW - 1, { price: usdc(0.005) }),
      obs("paid", "agent", NOW - 2, { price: usdc(0.001) }),
      obs("denied", "agent", NOW - 3, { price: usdc(0.005) }),
      obs("payment-failed", "agent", NOW - 4, { price: usdc(0.002) }),
      obs("served-free", "human", NOW - 5), // no price, ignored both sides
    ],
    NOW,
    HOUR,
  );
  assert.equal(s.earnings, 0.006);
  assert.equal(s.earningsMissed, 0.007);
});

test("splits agents into verified / unverified / masquerade", () => {
  const s = summarizeOps(
    [
      obs("paid", "agent", NOW - 1, { verified: true, verifiedAgent: "chatgpt.com" }),
      obs("denied", "agent", NOW - 2), // unverified (no signature)
      obs("denied", "agent", NOW - 3, { sigInvalid: true }), // masquerade
      obs("served-free", "human", NOW - 4), // not an agent
    ],
    NOW,
    HOUR,
  );
  assert.equal(s.agents.total, 3);
  assert.equal(s.agents.verified, 1);
  assert.equal(s.agents.unverified, 1);
  assert.equal(s.agents.masquerade, 1);
  assert.equal(s.humans, 1);
});

test("excludes observations older than the window", () => {
  const s = summarizeOps(
    [
      obs("served-free", "human", NOW - 10),
      obs("served-free", "human", NOW - 2 * HOUR), // outside a 1h window
    ],
    NOW,
    HOUR,
  );
  assert.equal(s.total, 1);
});

test("recent is newest-first and capped", () => {
  const events = Array.from({ length: 30 }, (_, i) => obs("denied", "agent", NOW - i));
  const s = summarizeOps(events, NOW, HOUR, 20);
  assert.equal(s.recent.length, 20);
  assert.deepEqual(
    s.recent.slice(0, 3).map((o) => o.at),
    [NOW, NOW - 1, NOW - 2],
  );
});

test("empty input is a zeroed, valid shape", () => {
  const s = summarizeOps([], NOW, HOUR);
  assert.equal(s.total, 0);
  assert.equal(s.earnings, 0);
  assert.equal(s.earningsMissed, 0);
  assert.equal(s.agents.total, 0);
  assert.deepEqual(s.recent, []);
  assert.equal(s.byVerdict["paid"], 0);
});
