/**
 * Connect for a site you run yourself, started from a terminal beside the app (`naulon connect`).
 *
 * The command and the running app share one directory (`.naulon/` by default, `NAULON_DIR` to move
 * it). The command writes the pending connect there; the app, which is what the gate can reach,
 * answers the gate's challenge from it and finishes the owner's return itself, writing the site's
 * credential beside it. `naulonSite()` reads that credential when `NAULON_KEY` is unset, so the app
 * starts tolling without a restart, and the command reports the result.
 *
 * Every file is the owner's alone (directory 0700, files 0600). `take` claims a pending connect by
 * renaming it, which exactly one process can do, so a refreshed return page or a second worker never
 * exchanges one code twice.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSiteCredential, isState } from "@naulon/shared";
import type { ConnectStore, PendingConnect } from "./connect.ts";

export const DEFAULT_DIR = ".naulon";

/** Where the command and the app meet: `NAULON_DIR`, else `.naulon` in the working directory. */
export function naulonDir(env: { NAULON_DIR?: string } = process.env): string {
  return resolve(env.NAULON_DIR?.trim() || DEFAULT_DIR);
}

export type ConnectResult = { ok: true; site: string; gate: string } | { ok: false; error: string; message: string };

export interface LocalConnectStore extends ConnectStore {
  /** The app records how a connect ended, for the command waiting on it. */
  putResult(state: string, result: ConnectResult): Promise<void>;
  /** The command reads it once. */
  takeResult(state: string): Promise<ConnectResult | null>;
  /** The site's credential, as the last connect left it, or null. */
  readCredential(): string | null;
  writeCredential(credential: string): void;
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Rename a file to a name only this caller knows, then read and remove it: an atomic take. */
function takeFile(path: string): string | null {
  const claimed = `${path}.${randomBytes(6).toString("hex")}.taken`;
  try {
    renameSync(path, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return readFileSync(claimed, "utf8");
  } finally {
    rmSync(claimed, { force: true });
  }
}

export function fileConnectStore(dir: string = naulonDir(), now: () => number = Date.now): LocalConnectStore {
  const connectDir = join(dir, "connect");
  mkdirSync(connectDir, { recursive: true, mode: 0o700 });
  const pendingPath = (state: string) => {
    // A state is a token from a URL: only its own alphabet ever names a file.
    if (!isState(state)) throw new Error("not a connect state");
    return join(connectDir, `pending-${state}.json`);
  };
  const resultPath = (state: string) => {
    if (!isState(state)) throw new Error("not a connect state");
    return join(connectDir, `result-${state}.json`);
  };
  const credentialPath = join(dir, "credential");
  const live = (raw: string | null): PendingConnect | null => {
    if (raw === null) return null;
    const p = JSON.parse(raw) as PendingConnect;
    return p.expiresAt > now() ? p : null;
  };
  return {
    async put(state, pending) {
      writeAtomic(pendingPath(state), JSON.stringify(pending));
    },
    async get(state) {
      return isState(state) ? live(readOrNull(pendingPath(state))) : null;
    },
    async take(state) {
      return isState(state) ? live(takeFile(pendingPath(state))) : null;
    },
    async putResult(state, result) {
      writeAtomic(resultPath(state), JSON.stringify(result));
    },
    async takeResult(state) {
      const raw = isState(state) ? takeFile(resultPath(state)) : null;
      return raw === null ? null : (JSON.parse(raw) as ConnectResult);
    },
    readCredential() {
      const raw = readOrNull(credentialPath)?.trim() ?? "";
      return isSiteCredential(raw) ? raw : null;
    },
    writeCredential(credential) {
      writeAtomic(credentialPath, `${credential}\n`);
    },
  };
}
