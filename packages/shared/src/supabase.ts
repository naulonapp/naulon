/**
 * A tiny Supabase client — just `fetch` against PostgREST, no SDK.
 *
 * We deliberately avoid `@supabase/supabase-js`: the only Supabase features the
 * toll needs are "insert a row" and "select rows", both of which PostgREST
 * exposes directly at `${SUPABASE_URL}/rest/v1/<table>`. Skipping the SDK keeps
 * the dependency tree flat, leaves the offline (jsonl/memory) path with nothing
 * extra to install, and runs unchanged on any runtime (Node or edge).
 *
 * Auth uses the service-role key in both `apikey` and `Authorization` — this
 * runs server-side only (tollgate/dashboard/attribution), never in a browser.
 */
import { getConfig } from "./config.ts";

function creds(): { url: string; key: string } {
  const cfg = getConfig();
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_KEY) {
    throw new Error(
      "Supabase backend selected but SUPABASE_URL / SUPABASE_SERVICE_KEY are unset. See .env.example.",
    );
  }
  return { url: cfg.SUPABASE_URL.replace(/\/$/, ""), key: cfg.SUPABASE_SERVICE_KEY };
}

/**
 * Call the Supabase REST (PostgREST) API and return the parsed JSON body.
 * Throws on any non-2xx so callers fail loud rather than silently losing a
 * write. `path` is everything after the project URL, e.g.
 * `/rest/v1/naulon_events?select=data&order=at.asc`.
 */
/**
 * A failed PostgREST call, carrying the HTTP status and PostgREST's own `code`.
 *
 * The fields exist so a caller can tell one class of failure from another WITHOUT string-matching
 * an error message. The case that forced it: a malformed row id is `400 22P02`, which is a MISS,
 * while a `503` is an outage — and treating those alike is how a lookup either lies about a row
 * existing or reports an incident as "not found".
 */
export class SupabaseRestError extends Error {
  readonly status: number;
  readonly body: string;
  /** PostgREST's error code (e.g. `22P02` — invalid text representation), when it sent one. */
  readonly code: string | undefined;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "SupabaseRestError";
    this.status = status;
    this.body = body;
    let code: unknown;
    try {
      code = (JSON.parse(body) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    this.code = typeof code === "string" ? code : undefined;
  }
}

export async function supabaseRest(path: string, init: RequestInit = {}): Promise<unknown> {
  const { url, key } = creds();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SupabaseRestError(`Supabase ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`, res.status, body);
  }
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/* ── paging ──────────────────────────────────────────────────────────────────── */

/** Rows per page. Any value works — the loop below never assumes it got what it asked for. */
export const PAGE_ROWS = 1000;

/**
 * Read every row of a paged PostgREST query.
 *
 * PostgREST clips a select at its own `db-max-rows` and answers 200 with no error and no header a
 * caller checks, so a clipped read is indistinguishable from a complete one and every consumer
 * treating it as a whole set is quietly wrong past the cap, forever.
 *
 * Two rules make this independent of that cap, and both are load-bearing:
 *   • terminate on an EMPTY page, never a short one — a deployment whose cap is below `pageRows`
 *     returns a short FIRST page, and reading that as "done" is the very truncation being killed;
 *   • advance by rows RECEIVED, not by what was asked for, for the same reason.
 *
 * `page` must apply a TOTAL order (a unique tiebreaker), or offset paging can repeat one row
 * across pages and never return another. It is a callback so callers keep their own URL building,
 * credentials and filters — those filters are the authorization, and hiding them behind a query
 * builder is how a scope goes quietly missing.
 *
 * Never returns a prefix: past `maxRows` it throws rather than hand back a partial set that reads
 * like a complete one.
 */
export async function readAllPaged<T>(opts: {
  /** Fetch one page. Must apply a total order. */
  page: (limit: number, offset: number) => Promise<T[]>;
  /** Rows requested per page. Default {@link PAGE_ROWS}. */
  pageRows?: number;
  /** Loud-failure ceiling for the whole read. */
  maxRows: number;
  /** Names the read in the ceiling error, e.g. `"eventsink.readAll"`. */
  what: string;
  /** Appended to the ceiling error — why a partial result would be harmful here. */
  because?: string;
}): Promise<T[]> {
  const pageRows = opts.pageRows ?? PAGE_ROWS;
  const out: T[] = [];
  for (;;) {
    const rows = await opts.page(pageRows, out.length);
    if (rows.length === 0) return out;
    out.push(...rows);
    // Either a real operational problem or a server ignoring `offset` (which would spin forever).
    if (out.length > opts.maxRows) {
      throw new Error(
        `${opts.what}: exceeded ${opts.maxRows} rows — refusing to return a partial result.` +
          (opts.because ? ` ${opts.because}` : ""),
      );
    }
  }
}
