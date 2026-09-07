/**
 * A malformed event id is NOT an outage.
 *
 * `supabaseSink.get()` reads `?id=eq.<id>`. Postgres refuses to cast a non-UUID and
 * PostgREST answers `400 22P02`, which `supabaseRest` throws — and the gate's verify
 * routes have no catch, so `GET /licenses/definitely-not-a-jti` served **503 "naulon is
 * temporarily unavailable — please retry shortly"** in production. That is a lie twice
 * over: nothing is unavailable, and retrying can never help. Measured on the prod gate
 * 2026-09-02 on both `/licenses/:jti` and `/licenses/:jti/record`.
 *
 * An id that cannot exist is a MISS. A real outage must still throw, or an outage would
 * report as "no such settlement" and the verify tier would deny real licences during an
 * incident — the strictly worse failure.
 */
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";

process.env.SUPABASE_URL ??= "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_KEY ??= "stub-key";
const { supabaseSink } = await import("./eventsink.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const respondWith = (status: number, body: string) => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};

test("a malformed id is a MISS, not an error — PostgREST 22P02", async () => {
  respondWith(400, JSON.stringify({ code: "22P02", message: 'invalid input syntax for type uuid: "not-a-jti"' }));
  assert.equal(await supabaseSink().get("not-a-jti"), undefined);
});

test("a real outage still THROWS — an incident must never read as 'no such settlement'", async () => {
  respondWith(503, "upstream connect error");
  await assert.rejects(() => supabaseSink().get("11111111-2222-4333-8444-555555555555"));
});

test("an unrelated 400 still THROWS — only the malformed-id code is swallowed", async () => {
  respondWith(400, JSON.stringify({ code: "42703", message: "column does not exist" }));
  await assert.rejects(() => supabaseSink().get("11111111-2222-4333-8444-555555555555"));
});

test("a well-formed id that simply is not there is still a plain miss", async () => {
  respondWith(200, "[]");
  assert.equal(await supabaseSink().get("11111111-2222-4333-8444-555555555555"), undefined);
});

test("a found row still comes back", async () => {
  respondWith(200, JSON.stringify([{ data: { id: "x", slug: "s" } }]));
  assert.deepEqual(await supabaseSink().get("x"), { id: "x", slug: "s" });
});
