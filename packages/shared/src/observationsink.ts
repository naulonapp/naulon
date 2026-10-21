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
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
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

/** The one rotated generation a jsonl observation log keeps beside the live file. */
export const rotatedObservationsPath = (path: string): string => `${path}.1`;

/**
 * Append-only JSONL file (single box). Every request a person makes is a line, so an
 * unbounded file is a disk that fills on a busy site. Past `maxBytes` the live file moves to
 * `<path>.1`, replacing the one before, and a new file starts: at most twice the cap on disk,
 * and the console reads both. The size is read once and then counted in process, so a write
 * costs no extra syscall.
 */
export function jsonlObservationSink(
  path?: string,
  maxBytes: number = getConfig().OBSERVATIONS_MAX_MB * 1024 * 1024,
): ObservationSink {
  const file = resolve(path ?? getConfig().OBSERVATIONS_PATH);
  let size: number | null = null;
  return {
    async record(observation) {
      await mkdir(dirname(file), { recursive: true });
      const line = JSON.stringify(observation) + "\n";
      if (maxBytes > 0) {
        size ??= await stat(file).then((s) => s.size, () => 0);
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          await rename(file, rotatedObservationsPath(file)).catch(() => {});
          size = 0;
        }
        size += Buffer.byteLength(line);
      }
      await appendFile(file, line, "utf8");
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
