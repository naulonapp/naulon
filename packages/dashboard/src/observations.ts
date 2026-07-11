/**
 * Read the gate's observation log for the ops view. The ObservationSink is
 * write-only from the gate's side (telemetry out), so the dashboard reads the
 * jsonl file the gate appends to. Off/supabase backends yield nothing here —
 * supabase reads are the cloud audit plane's job, not the self-host dashboard.
 */
import { readFile } from "node:fs/promises";
import { getConfig, type ObservationEvent } from "@naulon/shared";

export async function readObservations(path?: string): Promise<ObservationEvent[]> {
  const cfg = getConfig();
  if (cfg.OBSERVATIONS_BACKEND !== "jsonl") return [];

  let raw: string;
  try {
    raw = await readFile(path ?? cfg.OBSERVATIONS_PATH, "utf8");
  } catch {
    return []; // no file yet = no traffic recorded
  }

  const out: ObservationEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ObservationEvent);
    } catch {
      // Skip a torn last line / malformed row rather than fail the whole view.
    }
  }
  return out;
}
