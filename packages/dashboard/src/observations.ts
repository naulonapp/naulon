/**
 * Read the gate's observation log for the ops view. The ObservationSink is
 * write-only from the gate's side (telemetry out), so the dashboard reads the
 * jsonl file the gate appends to. Off/supabase backends yield nothing here —
 * supabase reads are the cloud audit plane's job, not the self-host dashboard.
 *
 * The overview reads this every second while it is open, so the file is FOLLOWED rather than
 * re-read: each call parses only the bytes appended since the last one. A rotation (the sink
 * moves the live file to `<path>.1`) or a truncation shows up as a new inode or a shorter
 * file, and that file alone is read again from the start.
 */
import { open, stat } from "node:fs/promises";
import { getConfig, rotatedObservationsPath, type ObservationEvent } from "@naulon/shared";
import { OPS_WINDOWS } from "./ops.ts";

/** No console view reaches further back than its widest window, so older rows are let go. */
const KEEP_MS = Math.max(...Object.values(OPS_WINDOWS));

interface Followed {
  ino: number;
  offset: number;
  /** A last line the gate had not finished writing, held until its newline arrives. */
  partial: string;
  rows: ObservationEvent[];
}

const followed = new Map<string, Followed>();

async function follow(path: string, now: number): Promise<ObservationEvent[]> {
  let info;
  try {
    info = await stat(path);
  } catch {
    followed.delete(path); // no file yet = no traffic recorded
    return [];
  }
  let f = followed.get(path);
  if (!f || f.ino !== info.ino || info.size < f.offset) {
    f = { ino: info.ino, offset: 0, partial: "", rows: [] };
    followed.set(path, f);
  }
  if (info.size > f.offset) {
    const handle = await open(path, "r");
    try {
      const length = info.size - f.offset;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, f.offset);
      f.offset += bytesRead;
      const lines = (f.partial + buf.subarray(0, bytesRead).toString("utf8")).split("\n");
      f.partial = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          f.rows.push(JSON.parse(t) as ObservationEvent);
        } catch {
          // Skip a malformed row rather than fail the whole view.
        }
      }
    } finally {
      await handle.close();
    }
  }
  const cutoff = now - KEEP_MS;
  if (f.rows.length && f.rows[0]!.at < cutoff) f.rows = f.rows.filter((o) => o.at >= cutoff);
  return f.rows;
}

export async function readObservations(path?: string, now: number = Date.now()): Promise<ObservationEvent[]> {
  const cfg = getConfig();
  if (cfg.OBSERVATIONS_BACKEND !== "jsonl") return [];
  const live = path ?? cfg.OBSERVATIONS_PATH;
  const [older, newer] = await Promise.all([follow(rotatedObservationsPath(live), now), follow(live, now)]);
  return older.length ? older.concat(newer) : newer.slice();
}
