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
    throw new Error(`Supabase ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}
