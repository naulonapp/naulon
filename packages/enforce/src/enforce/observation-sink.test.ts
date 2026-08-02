import { test } from "node:test";
import assert from "node:assert/strict";
import { httpObservationSink, type ObservationReport } from "./observation-sink.ts";

const report = (over?: Partial<ObservationReport>): ObservationReport => ({
  resource: "http://h/essays/x",
  slug: "x",
  verdict: "denied",
  classifiedAs: "agent",
  kind: "read",
  priceMicro: 1000,
  at: 1_000,
  ...over,
});

/** Drain the microtask queue — the reporter is fire-and-forget by contract. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("POSTs the report to the hosted /observe with the key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
  }) as unknown as typeof fetch;

  httpObservationSink("http://cloud/_naulon/observe", "nln_live_k", fetchImpl)(report());
  await settled();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://cloud/_naulon/observe");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer nln_live_k");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), report());
});

test("returns void — no caller can await it and make a reader wait", () => {
  const fetchImpl = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
  assert.equal(httpObservationSink("http://cloud/o", "k", fetchImpl)(report()), undefined);
});

test("a rejected POST is swallowed — a reporting outage never reaches a reader", async () => {
  const errors: unknown[] = [];
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const sink = httpObservationSink("http://cloud/o", "k", fetchImpl, (e) => void errors.push(e));
  assert.doesNotThrow(() => sink(report()));
  await settled();
  assert.equal(errors.length, 1);
});

test("a SYNCHRONOUSLY throwing fetch is swallowed too", () => {
  const errors: unknown[] = [];
  const fetchImpl = (() => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  const sink = httpObservationSink("http://cloud/o", "k", fetchImpl, (e) => void errors.push(e));
  assert.doesNotThrow(() => sink(report()));
  assert.equal(errors.length, 1);
});

test("a refusal response is not an exception — it is swallowed like any other outcome", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 400 })) as unknown as typeof fetch;
  const sink = httpObservationSink("http://cloud/o", "k", fetchImpl);
  assert.doesNotThrow(() => sink(report()));
  await settled();
});
