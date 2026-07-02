/**
 * ObservationSink — the audit plane's write side. The branchy bits worth pinning:
 * the default is OFF (records nothing), the memory sink exposes what it captured,
 * and getObservationSink honours the env switch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getObservationSink,
  memoryObservationSink,
  noopObservationSink,
} from "./observationsink.ts";
import type { ObservationEvent } from "./types.ts";

function obs(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: "obs-1",
    publisherId: "pub_a",
    host: "site.com",
    slug: "on-stillness",
    verdict: "denied",
    classifiedAs: "agent",
    at: 1,
    ...overrides,
  };
}

test("memory sink records what it's given and exposes it", async () => {
  const sink = memoryObservationSink();
  assert.equal(sink.recorded.length, 0);
  await sink.record(obs());
  await sink.record(obs({ id: "obs-2", verdict: "paid" }));
  assert.equal(sink.recorded.length, 2);
  assert.deepEqual(
    sink.recorded.map((o) => o.verdict),
    ["denied", "paid"],
  );
});

test("memory sink seeds from an initial set", async () => {
  const sink = memoryObservationSink([obs({ id: "seed" })]);
  assert.equal(sink.recorded.length, 1);
  assert.equal(sink.recorded[0]!.id, "seed");
});

test("noop sink records nothing and never throws", async () => {
  const sink = noopObservationSink();
  await assert.doesNotReject(sink.record(obs()));
  // No observable state — the contract is "swallow it". The assertion is that it
  // resolves without error; there is nothing to read back.
});

test("getObservationSink defaults to a no-op when OBSERVATIONS_BACKEND is unset", async () => {
  // The open-core default: observability is opt-in, so the factory must hand back
  // a sink that stores nothing rather than touching disk or a network.
  delete process.env.OBSERVATIONS_BACKEND;
  const sink = getObservationSink();
  await assert.doesNotReject(sink.record(obs()));
});
