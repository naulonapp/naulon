/**
 * EventSink implementations. The default is an append-only JSONL file keyed off
 * EVENTS_PATH, so the tollgate (writer) and the dashboard/attribution (readers)
 * all agree on one ledger without a database. Swap in another EventSink to move
 * to Postgres/Supabase — callers don't change.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.ts";
import { supabaseRest } from "./supabase.ts";
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
 * Supabase-backed sink. Each event is stored as one row: its `id` (primary key,
 * so a retried write is idempotent), its `at` timestamp (indexed, for ordering),
 * and the whole `AttributedEvent` as a jsonb `data` column — so `readAll` hands
 * back the exact shape the writer stored, with no field-by-field mapping to drift.
 * This is the backend to use on serverless/multi-instance hosts with no shared disk.
 */
export function supabaseSink(): EventSink {
  const table = getConfig().SUPABASE_EVENTS_TABLE;
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
      const rows = (await supabaseRest(
        `/rest/v1/${table}?select=data&order=at.asc${scope}`,
      )) as Array<{ data: AttributedEvent }>;
      return rows.map((r) => r.data);
    },
    async get(id) {
      // Primary-key lookup — never reads the whole table.
      const rows = (await supabaseRest(
        `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=data&limit=1`,
      )) as Array<{ data: AttributedEvent }>;
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
