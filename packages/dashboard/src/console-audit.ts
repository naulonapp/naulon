/**
 * Who did what on the console.
 *
 * This is the whole payoff of having accounts. A hashed shared credential is a better
 * secret; it still cannot answer "who ran that test toll", and that question is the one
 * an operator asks after something moved. Sessions without an audit trail buy a nicer
 * login page and nothing else.
 *
 * Append-only JSONL beside the event ledger, same shape discipline as the gate's own
 * `events.jsonl`: one self-describing record per line, never rewritten. A hosted control
 * plane built on this core has a much larger version of the idea (retention, DSR export)
 * and this deliberately does NOT try to be it — such a plane audits many
 * tenants and must answer subject-access requests; a self-host console needs a log its
 * owner can `tail`.
 *
 * Failures here are swallowed. An audit write that takes the console down converts a
 * record-keeping problem into an outage, and the operator loses the console AND the log.
 * A failed append is reported once at the call site's discretion, never thrown at a user
 * mid-action.
 */
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ConsoleActorKind = "session" | "machine" | "anonymous";

export interface ConsoleAuditActor {
  kind: ConsoleActorKind;
  /** Absent for `anonymous`, and for `machine` (the credential has no account behind it). */
  userId?: string;
  /** `ops` for a session, `DASHBOARD_AUTH` for the machine credential, `-` for anonymous. */
  name: string;
  role?: string;
}

export type ConsoleAuditOutcome = "ok" | "refused" | "failed";

export interface ConsoleAuditRecord {
  at: string;
  action: string;
  outcome: ConsoleAuditOutcome;
  actor: ConsoleAuditActor;
  ip?: string;
  /** Small, non-secret specifics: the account acted on, the route, the reason for a refusal. */
  detail?: Record<string, string | number | boolean>;
}

export interface ConsoleAuditor {
  record(entry: Omit<ConsoleAuditRecord, "at">): Promise<void>;
  /** Null when nothing is being written (read-only filesystem) — the boot line says so. */
  readonly path: string | null;
}

export const anonymousActor = (): ConsoleAuditActor => ({ kind: "anonymous", name: "-" });

export const auditPathFor = (statePath: string): string => join(dirname(statePath), "console-audit.jsonl");

export function createAuditor(path: string | null, now: () => Date = () => new Date()): ConsoleAuditor {
  return {
    path,
    async record(entry) {
      if (!path) return;
      const line = JSON.stringify({ at: now().toISOString(), ...entry });
      try {
        await appendFile(path, `${line}\n`, { mode: 0o600 });
      } catch {
        // Deliberately silent — see the header. The console keeps working.
      }
    },
  };
}

/** For tests and for the serverless path, where there is nowhere to append. */
export function memoryAuditor(now: () => Date = () => new Date()): ConsoleAuditor & { entries: ConsoleAuditRecord[] } {
  const entries: ConsoleAuditRecord[] = [];
  return {
    path: null,
    entries,
    async record(entry) {
      entries.push({ at: now().toISOString(), ...entry });
    },
  };
}
