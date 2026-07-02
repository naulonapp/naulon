/**
 * ObservationSink implementations — the audit/observability plane's write side.
 * A sibling of `eventsink.ts`, but for the *negative space* the settlement ledger
 * never sees: crawlers served free, agents denied at the 402, agents that paid.
 *
 * The default is `off` (a no-op): the open core emits nothing unless a deploy
 * opts in, so the gate's "humans read free at zero added cost" promise holds and
 * no observation data accumulates without intent. A multi-tenant embedder
 * (the control plane) sets OBSERVATIONS_BACKEND=supabase to stream observations into
 * its own audit table — exactly how settlement events already flow gate → cloud.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.ts";
import { supabaseRest } from "./supabase.ts";
import type { ObservationEvent, ObservationSink } from "./types.ts";

/** Records nothing. The default — observability is opt-in. */
export function noopObservationSink(): ObservationSink {
  return {
    async record() {
      /* intentionally empty */
    },
  };
}

/** Append-only JSONL file (dev / single-box). Mirrors `jsonlSink`. */
export function jsonlObservationSink(path?: string): ObservationSink {
  const file = resolve(path ?? getConfig().OBSERVATIONS_PATH);
  return {
    async record(observation) {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(observation) + "\n", "utf8");
    },
  };
}

/**
 * Supabase-backed sink. One row per observation: `id` (primary key, idempotent
 * retry), `at` (indexed, for ordering + TTL sweeps), `publisher` (top-level so the
 * audit BFF filters server-side), and the whole `ObservationEvent` as jsonb `data`.
 * The downstream owns the table + its retention policy; this only writes.
 */
export function supabaseObservationSink(): ObservationSink {
  const table = getConfig().SUPABASE_OBSERVATIONS_TABLE;
  return {
    async record(observation) {
      await supabaseRest(`/rest/v1/${table}?on_conflict=id`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify([
          {
            id: observation.id,
            at: observation.at,
            publisher: observation.publisherId ?? null,
            data: observation,
          },
        ]),
      });
    },
  };
}

/**
 * Pick the ObservationSink the config asks for. `off` (default) → no-op; `jsonl`
 * → local file; `supabase` → the shared table. One env var, like `getSink`.
 */
export function getObservationSink(): ObservationSink {
  switch (getConfig().OBSERVATIONS_BACKEND) {
    case "supabase":
      return supabaseObservationSink();
    case "jsonl":
      return jsonlObservationSink();
    default:
      return noopObservationSink();
  }
}

/** In-memory sink, handy for tests — exposes what was recorded. */
export function memoryObservationSink(seed: ObservationEvent[] = []): ObservationSink & {
  readonly recorded: ObservationEvent[];
} {
  const recorded = [...seed];
  return {
    recorded,
    async record(observation) {
      recorded.push(observation);
    },
  };
}
