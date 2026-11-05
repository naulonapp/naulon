/**
 * The gate's own state: the secrets it generated for itself, its owner, its publisher settings and
 * the site credentials it issued. A small key-value store, because every one of those is read by key
 * and written rarely.
 *
 * Three backends:
 *   memory    tests, and a gate run once for a demo.
 *   file      the default. One file per key under `NAULON_DATA_DIR` (directory 0700, files 0600).
 *             `createIfAbsent` is an `O_EXCL` create, so two processes on one disk agree on a value
 *             without a lock.
 *   supabase  several instances. `createIfAbsent` is an insert that ignores a duplicate and then
 *             reads the row back, so every instance converges on the first value written.
 *
 * `createIfAbsent` is the only write first boot uses: whoever writes first wins, and everyone else
 * reads the winner. That is what lets instances boot at once without generating different secrets.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readAllPaged, supabaseRestWith } from "../supabase.ts";

export interface GateStateStore {
  readonly kind: "memory" | "file" | "supabase";
  get(key: string): Promise<string | null>;
  /** Write `value` unless the key exists. Returns the value now stored, whoever wrote it. */
  createIfAbsent(key: string, value: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key starting with `prefix`, with its value. */
  list(prefix: string): Promise<{ key: string; value: string }[]>;
}

const KEY = /^[a-z][a-z0-9_.:-]{0,190}$/;

function checkKey(key: string): void {
  if (!KEY.test(key)) throw new Error(`invalid state key ${JSON.stringify(key)}`);
}

export function memoryStateStore(): GateStateStore {
  const rows = new Map<string, string>();
  return {
    kind: "memory",
    async get(key) {
      checkKey(key);
      return rows.get(key) ?? null;
    },
    async createIfAbsent(key, value) {
      checkKey(key);
      const held = rows.get(key);
      if (held !== undefined) return held;
      rows.set(key, value);
      return value;
    },
    async put(key, value) {
      checkKey(key);
      rows.set(key, value);
    },
    async delete(key) {
      checkKey(key);
      rows.delete(key);
    },
    async list(prefix) {
      return [...rows].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
    },
  };
}

/** A key's file name. Keys are already a safe alphabet; `:` is swapped because it is not portable. */
const fileOf = (key: string): string => `${key.replaceAll(":", "~")}.v`;
const keyOf = (file: string): string | null => (file.endsWith(".v") ? file.slice(0, -2).replaceAll("~", ":") : null);

export function fileStateStore(dir: string): GateStateStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = (key: string) => join(dir, fileOf(key));
  const writeTemp = (value: string): string => {
    const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmp;
  };
  const read = (key: string): string | null => {
    try {
      return readFileSync(path(key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  return {
    kind: "file",
    async get(key) {
      checkKey(key);
      return read(key);
    },
    async createIfAbsent(key, value) {
      checkKey(key);
      // Written and synced under a temporary name, then hard-linked into place. `link` refuses an
      // existing target atomically, and the target only ever appears complete, so a reader never
      // sees half a secret and two writers never both win.
      const tmp = writeTemp(value);
      try {
        linkSync(tmp, path(key));
        return value;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const held = read(key);
        if (held === null) throw new Error(`state key ${key} vanished while being read`);
        return held;
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    async put(key, value) {
      checkKey(key);
      renameSync(writeTemp(value), path(key));
    },
    async delete(key) {
      checkKey(key);
      rmSync(path(key), { force: true });
    },
    async list(prefix) {
      const out: { key: string; value: string }[] = [];
      for (const f of readdirSync(dir).sort()) {
        const key = keyOf(f);
        if (key === null || !key.startsWith(prefix)) continue;
        const value = read(key);
        if (value !== null) out.push({ key, value });
      }
      return out;
    },
  };
}

const TABLE = "/rest/v1/naulon_gate_state";

export interface SupabaseCreds {
  url: string;
  key: string;
}

export function supabaseStateStore(creds: SupabaseCreds): GateStateStore {
  const supabaseRest = (path: string, init?: RequestInit) => supabaseRestWith(creds, path, init);
  const one = async (key: string): Promise<string | null> => {
    // `key` is the primary key, so one row at most; the limit says so to PostgREST too.
    const rows = (await supabaseRest(`${TABLE}?key=eq.${encodeURIComponent(key)}&select=value&limit=1`)) as { value: string }[];
    return rows[0]?.value ?? null;
  };
  return {
    kind: "supabase",
    async get(key) {
      checkKey(key);
      return one(key);
    },
    async createIfAbsent(key, value) {
      checkKey(key);
      await supabaseRest(`${TABLE}?on_conflict=key`, {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ key, value }),
      });
      const held = await one(key);
      if (held === null) throw new Error(`state key ${key} was not stored`);
      return held;
    },
    async put(key, value) {
      checkKey(key);
      await supabaseRest(`${TABLE}?on_conflict=key`, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
    },
    async delete(key) {
      checkKey(key);
      await supabaseRest(`${TABLE}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
    },
    async list(prefix) {
      // A key's alphabet holds no `%`, but it does hold `_`, which LIKE reads as any one character.
      const pattern = `${prefix.replaceAll("_", "\\_")}*`;
      // Paged: PostgREST clips a read at db-max-rows and still answers 200, and a clipped list of
      // credentials is a Sites page missing rows and a sweep that never reaches the rest.
      return readAllPaged({
        what: "gate state list",
        maxRows: 1_000_000,
        because: "a partial list would hide credentials from their owner.",
        page: async (limit, offset) =>
          (await supabaseRest(`${TABLE}?key=like.${encodeURIComponent(pattern)}&select=key,value&order=key.asc&limit=${limit}&offset=${offset}`)) as { key: string; value: string }[],
      });
    },
  };
}

export type StateBackend = "memory" | "file" | "supabase";

export function stateStoreFor(backend: StateBackend, dataDir: string, env: NodeJS.ProcessEnv = process.env): GateStateStore {
  if (backend === "memory") return memoryStateStore();
  if (backend === "supabase") {
    const url = env.SUPABASE_URL?.trim();
    const key = env.SUPABASE_SERVICE_KEY?.trim();
    if (!url || !key) throw new Error("NAULON_STATE_BACKEND=supabase needs SUPABASE_URL and SUPABASE_SERVICE_KEY. See .env.example.");
    return supabaseStateStore({ url, key });
  }
  return fileStateStore(dataDir);
}
