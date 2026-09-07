/**
 * EventSink implementations. The default is an append-only JSONL file keyed off
 * EVENTS_PATH, so the tollgate (writer) and the dashboard/attribution (readers)
 * all agree on one ledger without a database. Swap in another EventSink to move
 * to Postgres/Supabase — callers don't change.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.ts";
import { readAllPaged, supabaseRest, SupabaseRestError } from "./supabase.ts";
import type { AttributedEvent, EventSink } from "./types.ts";

export function jsonlSink(path?: string): EventSink {
  const file = resolve(path ?? getConfig().EVENTS_PATH);
  return {
    async record(event) {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(event) + "\n", "utf8");
    },
    async readAll(publisherId?) {
      try {
        const raw = await readFile(file, "utf8");
        const events = raw
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as AttributedEvent);
        // jsonl is the single-box/dev backend, but honour the optional scope so a
        // scoped read over a local ledger sees only that publisher's events.
        return publisherId === undefined ? events : events.filter((e) => e.publisherId === publisherId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
    async get(id) {
      try {
        const raw = await readFile(file, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AttributedEvent;
          if (event.id === id) return event; // short-circuit on first match
        }
        return undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
  };
}

/**
 * Rows per `readAll` page. PostgREST caps every response at its own `db-max-rows`
 * (1000 in prod), so asking for more than that is pointless — but asking for LESS
 * would be wrong too, since the cap is what the page loop is defending against.
 */

/**
 * Ceiling on a single `readAll` result. Not a limit anyone should hit: it is a
 * loud tripwire for a runaway ledger or a server that ignores `offset`, chosen so
 * that crossing it is a real operational event rather than routine. Overridable
 * so the guard itself can be exercised, and so a deployment that genuinely
 * outgrows it raises the bound deliberately instead of editing this file.
 */
const DEFAULT_MAX_LEDGER_ROWS = 500_000;

/** Knobs for {@link supabaseSink}. Every field is optional; defaults are prod's. */
export interface SupabaseSinkOptions {
  /** Loud-failure ceiling on one `readAll`. Default {@link DEFAULT_MAX_LEDGER_ROWS}. */
  maxLedgerRows?: number;
}

/**
 * Supabase-backed sink. Each event is stored as one row: its `id` (primary key,
 * so a retried write is idempotent), its `at` timestamp (indexed, for ordering),
 * and the whole `AttributedEvent` as a jsonb `data` column — so `readAll` hands
 * back the exact shape the writer stored, with no field-by-field mapping to drift.
 * This is the backend to use on serverless/multi-instance hosts with no shared disk.
 *
 * `readAll` PAGINATES. It must: PostgREST truncates any unbounded select at
 * `db-max-rows` and reports no error when it does, and this function is the read
 * primitive under earnings, author earnings, author receipts, the dashboard and
 * operator rollups, pulse, settlement-fact webhooks and the settlement drain. An
 * unpaginated read therefore did not merely starve the sweep — past the cap, with
 * `order=at.asc`, every one of those planes would have gone on reporting the
 * OLDEST 1000 events forever and silently stopped counting new money.
 */
export function supabaseSink(opts: SupabaseSinkOptions = {}): EventSink {
  const table = getConfig().SUPABASE_EVENTS_TABLE;
  const maxLedgerRows = opts.maxLedgerRows ?? DEFAULT_MAX_LEDGER_ROWS;
  return {
    async record(event) {
      await supabaseRest(`/rest/v1/${table}?on_conflict=id`, {
        method: "POST",
        // Idempotent: a row with this id already? ignore, don't error.
        headers: { Prefer: "resolution=ignore-duplicates" },
        // `publisher` is a top-level column (not just inside `data`) so a scoped
        // `readAll` can filter rows server-side. Null for single-tenant writes.
        body: JSON.stringify([{ id: event.id, at: event.at, publisher: event.publisherId ?? null, data: event }]),
      });
    },
    async readAll(publisherId?) {
      const scope = publisherId === undefined ? "" : `&publisher=eq.${encodeURIComponent(publisherId)}`;
      const rows = await readAllPaged<{ data: AttributedEvent }>({
        // `at,id` is a TOTAL order: `at` alone ties for events written in the same millisecond, and
        // a tie under offset paging drops rows. The publisher scope rides every page, not just the first.
        page: (limit, offset) =>
          supabaseRest(
            `/rest/v1/${table}?select=data&order=at.asc,id.asc${scope}&limit=${limit}&offset=${offset}`,
          ) as Promise<Array<{ data: AttributedEvent }>>,
        maxRows: maxLedgerRows,
        what: "eventsink.readAll",
        because:
          "Earnings, author receipts and the settlement drain all ride this path, so a truncated " +
          "result would silently under-report money. Scope the read or raise the bound deliberately.",
      });
      return rows.map((r) => r.data);
    },

    async get(id) {
      // Primary-key lookup — never reads the whole table.
      let rows: Array<{ data: AttributedEvent }>;
      try {
        rows = (await supabaseRest(
          `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=data&limit=1`,
        )) as Array<{ data: AttributedEvent }>;
      } catch (err) {
        // An id Postgres cannot even cast is an id no row can have — a MISS, not a failure.
        // PostgREST answers `400 22P02` (invalid text representation) for it. Without this the
        // throw reached the gate's error handler and `GET /licenses/<garbage>` served 503
        // "temporarily unavailable — please retry shortly", which is untrue twice: nothing is
        // down, and retrying can never help. Measured on the prod gate 2026-09-02.
        //
        // ONLY that code. Every other failure still throws, because an outage reporting as
        // "no such settlement" would deny real licences during an incident — strictly worse
        // than a 503.
        if (err instanceof SupabaseRestError && err.code === "22P02") return undefined;
        throw err;
      }
      return rows[0]?.data;
    },
  };
}

/**
 * Pick the EventSink the config asks for. JSONL file by default (offline, no
 * creds); Supabase when EVENTS_BACKEND=supabase. Callers use this instead of
 * naming a sink directly, so switching backends is one env var.
 */
export function getSink(): EventSink {
  return getConfig().EVENTS_BACKEND === "supabase" ? supabaseSink() : jsonlSink();
}

/** In-memory sink, handy for tests. */
export function memorySink(seed: AttributedEvent[] = []): EventSink {
  const events = [...seed];
  return {
    async record(event) {
      events.push(event);
    },
    async readAll(publisherId?) {
      return publisherId === undefined ? [...events] : events.filter((e) => e.publisherId === publisherId);
    },
    async get(id) {
      return events.find((e) => e.id === id);
    },
  };
}
