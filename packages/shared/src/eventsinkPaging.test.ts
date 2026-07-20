/**
 * `supabaseSink.readAll` must page.
 *
 * PostgREST truncates any unbounded select at its own `db-max-rows` and returns
 * 200 with no error when it does — prod runs 1000. `readAll` is the read
 * primitive under earnings, author earnings, author receipts, the dashboard and
 * operator rollups, pulse, settlement-fact webhooks and the settlement drain, so
 * an unpaginated read meant that past the cap, with `order=at.asc`, every one of
 * those planes would keep reporting the OLDEST 1000 events and silently stop
 * counting new money. These tests fail against the single-shot read.
 *
 * The whole PostgREST server is faked at `globalThis.fetch`, which is the seam
 * `supabaseRest` actually uses — so the assertions cover the real URL the sink
 * builds (order, scope, limit, offset), not a re-implementation of it.
 *
 * Env must be set before any getConfig() call — it caches on first read, and
 * node's test runner gives this file its own process. Creds are stubs (`"k"`,
 * matching config.test.ts); nothing here talks to a real project.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "k";
process.env.EVENTS_BACKEND = "supabase";
// A supabase backend otherwise demands a stable license signing key (config.ts
// `needsStableKey`). Licensing is irrelevant to how a ledger read pages, so turn
// it off rather than mint a key this test would never use.
process.env.LICENSES_ENABLED = "false";

const { supabaseSink } = await import("./eventsink.ts");
import type { AttributedEvent, Usdc, WalletAddress } from "./types.ts";

const PAYER = "0x3333333333333333333333333333333333333333" as WalletAddress;

function evt(n: number, publisherId?: string): AttributedEvent {
  return {
    id: `evt-${String(n).padStart(6, "0")}`,
    publisherId,
    slug: "on-stillness",
    kind: "read",
    amount: 1000 as Usdc,
    payees: [],
    payerAddress: PAYER,
    settlementRef: "0xfeed",
    at: 1_700_000_000_000 + n,
  };
}

/**
 * Stand up a fake PostgREST that honours `limit`/`offset` and — crucially —
 * enforces its OWN `db-max-rows` cap, silently, exactly as the real one does.
 * Returns the URL log so a test can assert how the sink actually paged.
 */
function fakePostgrest(rows: AttributedEvent[], serverMaxRows: number) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    const publisher = url.searchParams.get("publisher");
    const scoped =
      publisher === null ? rows : rows.filter((r) => r.publisherId === publisher.replace(/^eq\./, ""));
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const asked = Number(url.searchParams.get("limit") ?? String(serverMaxRows));
    // The silent truncation: the server never returns more than its cap, and
    // never says that it clipped.
    const take = Math.min(asked, serverMaxRows);
    const page = scoped.slice(offset, offset + take);
    return new Response(JSON.stringify(page.map((data) => ({ data }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { urls, restore: (): void => void (globalThis.fetch = original) };
}

test("readAll returns the WHOLE ledger when it exceeds the server's max-rows cap", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => evt(i, "publisher-a"));
  const srv = fakePostgrest(rows, 1000);
  try {
    const got = await supabaseSink().readAll("publisher-a");
    // The bug: the old single-shot read returned exactly the oldest 1000.
    assert.equal(got.length, 2500, "every event must come back, not just the first page");
    assert.equal(got[0]?.id, "evt-000000");
    assert.equal(got[2499]?.id, "evt-002499", "the NEWEST event must be reachable — this is the money bug");
  } finally {
    srv.restore();
  }
});

test("paging advances by rows RECEIVED, so a server cap below the page size still yields everything", async () => {
  // If the loop advanced by the REQUESTED page size (1000) against a server that
  // caps at 250, it would skip 750 events per page. If it stopped on a SHORT page
  // it would return only 250. Both are silent truncation; neither is acceptable.
  const rows = Array.from({ length: 900 }, (_, i) => evt(i, "publisher-a"));
  const srv = fakePostgrest(rows, 250);
  try {
    const got = await supabaseSink().readAll("publisher-a");
    assert.equal(got.length, 900);
    assert.deepEqual(
      got.map((e) => e.id),
      rows.map((e) => e.id),
      "no event skipped and none duplicated across page boundaries",
    );
  } finally {
    srv.restore();
  }
});

test("readAll orders by a TOTAL order (at, id) so pages cannot skip or duplicate on ties", async () => {
  const srv = fakePostgrest([], 1000);
  try {
    await supabaseSink().readAll("publisher-a");
    const first = srv.urls[0] ?? "";
    // `at` alone is not unique — events minted in the same millisecond tie, and a
    // non-deterministic tiebreak lets a row straddle a page boundary and be
    // returned twice or missed entirely. `id` is the primary key, so (at,id) is total.
    assert.match(decodeURIComponent(first), /order=at\.asc,id\.asc/);
  } finally {
    srv.restore();
  }
});

test("the publisher scope is re-applied on EVERY page, not just the first", async () => {
  const rows = [
    ...Array.from({ length: 1200 }, (_, i) => evt(i, "publisher-a")),
    ...Array.from({ length: 5 }, (_, i) => evt(9000 + i, "publisher-b")),
  ];
  const srv = fakePostgrest(rows, 1000);
  try {
    const got = await supabaseSink().readAll("publisher-a");
    assert.equal(got.length, 1200);
    assert.ok(
      got.every((e) => e.publisherId === "publisher-a"),
      "a page that dropped the scope would leak another tenant's events into this one's earnings",
    );
    assert.ok(srv.urls.length >= 2, "expected more than one page");
    assert.ok(
      srv.urls.every((u) => u.includes("publisher=eq.publisher-a")),
      "tenant isolation is a security boundary — every page must carry the filter",
    );
  } finally {
    srv.restore();
  }
});

test("an empty ledger costs exactly one request and returns []", async () => {
  const srv = fakePostgrest([], 1000);
  try {
    assert.deepEqual(await supabaseSink().readAll("publisher-a"), []);
    assert.equal(srv.urls.length, 1);
  } finally {
    srv.restore();
  }
});

test("a server that ignores `offset` fails LOUD instead of looping forever", async () => {
  // Pathological but not imaginary: a proxy that strips query params would serve
  // page 1 forever. Spinning silently is the one outcome worse than an error.
  const rows = Array.from({ length: 100 }, (_, i) => evt(i, "publisher-a"));
  const original = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(JSON.stringify(rows.map((data) => ({ data }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => supabaseSink({ maxLedgerRows: 500 }).readAll("publisher-a"),
      /refusing to return a partial ledger/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
