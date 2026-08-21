/**
 * Where the console's own identity state lives: operators, and their sessions.
 *
 * A JSON file, not a database, and the reasoning is worth keeping because "just use
 * SQLite" is the reflex answer:
 *
 *   - This package has four dependencies and none of them is native. `better-sqlite3`
 *     needs a compiler on a self-hoster's box; a self-host install that fails on a
 *     missing toolchain is a distribution bug, not a footnote.
 *   - `node:sqlite` on the node:22 runtime this ships against needs
 *     `--experimental-sqlite`. An auth store is the last place to spend an experimental
 *     flag.
 *   - The console ships a SERVERLESS entrypoint (api/index.ts) where there is no writable
 *     filesystem at all. A database file is not merely awkward there, it is impossible —
 *     and so is this file, which is why `writable` is a probe rather than an assumption
 *     and why the machine credential (DASHBOARD_AUTH) has to keep working.
 *   - `data/events.jsonl` already forces the operator to mount a volume. If they have no
 *     volume they have no ledger either, so sessions are not the thing they lost.
 *
 * It stays behind an interface for one reason beyond testing: naulon-cloud can eventually
 * supply a store that delegates to the hosted portal (the shape Netdata uses — the agent
 * redirects to the Cloud for identity and inherits its roles), and that must be possible
 * WITHOUT forking this console. The seam is public, the hosted implementation is private:
 * the same one-way dependency the rest of the project runs on.
 *
 * Concurrency: one process, so an in-memory copy is the read path and every mutation is
 * serialised through a promise chain and written atomically (tmp + rename, mode 0600).
 * Two console processes sharing one state file would need re-reading under the lock; the
 * console is a singleton and nothing here pretends otherwise.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type ConsoleRole = "admin" | "viewer";

/**
 * Two roles, not three. Grafana has Viewer/Editor/Admin because it has dashboards to
 * edit; this console has read panels and six ops writes, so an "Editor" tier would be a
 * role with nothing to edit — vocabulary invented to look complete.
 */
export const CONSOLE_ROLES: readonly ConsoleRole[] = ["admin", "viewer"];

export interface ConsoleUser {
  id: string;
  /** Stored as typed; compared case-insensitively (nobody means a different account by `Ops`). */
  username: string;
  /** A scrypt PHC string from credential.ts. Never a password. */
  passwordHash: string;
  role: ConsoleRole;
  createdAt: string;
  passwordChangedAt: string;
  /** Set when disabled. A disabled user keeps their audit history; deleting them would erase it. */
  disabledAt?: string;
  /** True for an account seeded from CONSOLE_ADMIN_PASSWORD — the console forces a change. */
  mustChangePassword?: boolean;
}

export interface ConsoleSession {
  /**
   * The SHA-256 of the session token, never the token itself. Same discipline as the
   * password: a stolen state file must not be a set of live sessions, and there is no
   * reason the server needs the original value back.
   */
  tokenHash: string;
  userId: string;
  /** Absolute-lifetime anchor. Never moves. */
  createdAt: string;
  /** Idle-lifetime anchor. Moves, but not on every request — see session-store's touch floor. */
  lastSeenAt: string;
  /** For the operator's own "these are my sessions" view, and for the audit trail. */
  ip?: string;
  userAgent?: string;
}

export interface ConsoleState {
  version: 1;
  users: ConsoleUser[];
  sessions: ConsoleSession[];
}

export const emptyState = (): ConsoleState => ({ version: 1, users: [], sessions: [] });

export interface ConsoleStore {
  /** The current state. Cheap — served from memory after the first load. */
  read(): Promise<ConsoleState>;
  /**
   * Mutate under a lock. The callback gets a DRAFT it may edit in place; whatever it
   * returns is returned to the caller. The draft is persisted after it returns, so a
   * throw leaves the previous state intact.
   */
  update<T>(fn: (draft: ConsoleState) => T | Promise<T>): Promise<T>;
  /** False on a read-only filesystem (serverless). Sessions are impossible then, and say so. */
  readonly writable: boolean;
  /** Null for the in-memory store. Shown in the boot line so an operator can find the file. */
  readonly path: string | null;
}

/** Deep enough for this shape — arrays of flat records. Keeps a caller's draft from aliasing the cache. */
const clone = (s: ConsoleState): ConsoleState => ({
  version: 1,
  users: s.users.map((u) => ({ ...u })),
  sessions: s.sessions.map((x) => ({ ...x })),
});

/**
 * Parse defensively. A hand-edited or truncated state file must not crash the console at
 * boot — it degrades to "no users", which routes the operator to first-run setup rather
 * than to a stack trace. Anything unparseable is reported by the caller's boot line.
 */
export function parseState(raw: string): ConsoleState | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (d["version"] !== 1) return null;
  const users = Array.isArray(d["users"]) ? (d["users"] as ConsoleUser[]) : [];
  const sessions = Array.isArray(d["sessions"]) ? (d["sessions"] as ConsoleSession[]) : [];
  return {
    version: 1,
    users: users.filter(
      (u) =>
        typeof u?.id === "string" &&
        typeof u?.username === "string" &&
        typeof u?.passwordHash === "string" &&
        (u?.role === "admin" || u?.role === "viewer"),
    ),
    sessions: sessions.filter((s) => typeof s?.tokenHash === "string" && typeof s?.userId === "string"),
  };
}

export function createMemoryStore(seed: ConsoleState = emptyState()): ConsoleStore {
  let state = clone(seed);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    writable: true,
    path: null,
    async read() {
      return clone(state);
    },
    update<T>(fn: (draft: ConsoleState) => T | Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        const draft = clone(state);
        const out = await fn(draft);
        state = draft;
        return out;
      });
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
  };
}

/**
 * Is this path writable? Asked once, by writing — `access(W_OK)` answers a different
 * question on a read-only mount inside a container, and the answer that matters is
 * whether a rename lands.
 */
async function probeWritable(path: string): Promise<boolean> {
  const probe = `${path}.probe-${randomBytes(4).toString("hex")}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(probe, "", { mode: 0o600 });
    await rename(probe, `${probe}.ok`);
    await writeFile(`${probe}.ok`, "");
    const { unlink } = await import("node:fs/promises");
    await unlink(`${probe}.ok`);
    return true;
  } catch {
    return false;
  }
}

export async function createFileStore(path: string): Promise<ConsoleStore> {
  const writable = await probeWritable(path);

  let state: ConsoleState;
  try {
    state = parseState(await readFile(path, "utf8")) ?? emptyState();
  } catch {
    state = emptyState(); // absent is the normal first-run case, not an error
  }

  let chain: Promise<unknown> = Promise.resolve();

  async function persist(next: ConsoleState): Promise<void> {
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    // 0600 at CREATE time, not after: a world-readable window, however short, is a window
    // in which the session hashes were readable by every user on the box.
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600); // umask can still widen the mode above; this is the belt.
    await rename(tmp, path); // atomic within a filesystem — never a half-written state file
  }

  return {
    writable,
    path,
    async read() {
      return clone(state);
    },
    update<T>(fn: (draft: ConsoleState) => T | Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        const draft = clone(state);
        const out = await fn(draft);
        if (writable) await persist(draft);
        state = draft; // only after the write lands, so a failed write is not silently "saved"
        return out;
      });
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
  };
}

/** Default location: beside the event ledger, so it rides the volume the operator already mounts. */
export const defaultStatePath = (eventsPath: string): string => join(dirname(eventsPath), "console.json");
