/**
 * Export — hand the operator their own traffic and settlement records, in a format
 * a spreadsheet or a script can read. Their data; it costs us nothing to give it back,
 * and "can I get my numbers out" is a fair question to have an answer to.
 *
 * Read-only and pure: rows in, a string out. The caller owns reading the log and
 * choosing the window.
 */
import type { AttributedEvent, ObservationEvent } from "@naulon/shared";
import { payeeCut } from "./aggregate.ts";

export type ExportKind = "observations" | "events";
export type ExportFormat = "csv" | "jsonl";

export function parseKind(v: string | undefined): ExportKind {
  return v === "events" ? "events" : "observations";
}

export function parseFormat(v: string | undefined): ExportFormat {
  return v === "jsonl" ? "jsonl" : "csv";
}

/**
 * Quote one CSV field.
 *
 * The leading-quote clause is not cosmetic. Several fields here are attacker-supplied
 * — `agentUa` and `slug` come off the wire — and a spreadsheet treats a cell starting
 * `=`, `+`, `-`, `@`, tab or CR as a FORMULA, so a crawler could put executable content
 * into an operator's export by sending it as a User-Agent. Prefixing with an
 * apostrophe is the standard defusal: Excel/Sheets/LibreOffice all render the text and
 * none of them evaluate it. Doing this at the serializer means no caller can forget.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows → CSV, columns in the given order. Header row always present. */
export function toCsv<T>(rows: readonly T[], columns: readonly { key: string; get: (row: T) => unknown }[]): string {
  const head = columns.map((c) => csvField(c.key)).join(",");
  const body = rows.map((r) => columns.map((c) => csvField(c.get(r))).join(","));
  return [head, ...body].join("\n") + "\n";
}

/** Rows → newline-delimited JSON, one object per line. */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** epoch ms → ISO, so a spreadsheet sorts it and a human can read it. */
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Observation columns. `price` is written at full six-decimal precision as a bare
 * number — micro-USDC rounded to a spreadsheet's default two places would silently
 * report every sub-cent toll as zero.
 */
export const OBSERVATION_COLUMNS = [
  { key: "at", get: (o: ObservationEvent) => iso(o.at) },
  { key: "verdict", get: (o: ObservationEvent) => o.verdict },
  { key: "classifiedAs", get: (o: ObservationEvent) => o.classifiedAs },
  { key: "classifyReason", get: (o: ObservationEvent) => o.classifyReason ?? "" },
  { key: "host", get: (o: ObservationEvent) => o.host },
  { key: "slug", get: (o: ObservationEvent) => o.slug },
  { key: "kind", get: (o: ObservationEvent) => o.kind ?? "" },
  { key: "priceUsdc", get: (o: ObservationEvent) => (o.price === undefined ? "" : Number(o.price).toFixed(6)) },
  { key: "identity", get: (o: ObservationEvent) => (o.verified ? "verified" : o.sigInvalid ? "masquerade" : "unsigned") },
  { key: "verifiedAgent", get: (o: ObservationEvent) => o.verifiedAgent ?? "" },
  { key: "userAgent", get: (o: ObservationEvent) => o.agentUa ?? "" },
  { key: "id", get: (o: ObservationEvent) => o.id },
] as const;

/**
 * Settlement columns. `payees` is flattened to `wallet:amount` pairs rather than
 * dropped — a split payment is the interesting case, and a CSV that silently showed
 * only the first author would be worse than none. The per-author figure is the resolved
 * AMOUNT, not the raw fractional share, because a spreadsheet cell reading `0.7` next to
 * a wallet invites exactly one misreading; `payeeCut` is the single owner of that math.
 */
export const EVENT_COLUMNS = [
  { key: "at", get: (e: AttributedEvent) => iso(e.at) },
  { key: "slug", get: (e: AttributedEvent) => e.slug },
  { key: "kind", get: (e: AttributedEvent) => e.kind },
  { key: "amountUsdc", get: (e: AttributedEvent) => Number(e.amount).toFixed(6) },
  { key: "payerAddress", get: (e: AttributedEvent) => e.payerAddress },
  { key: "payees", get: (e: AttributedEvent) => e.payees.map((p) => `${p.wallet}:${payeeCut(e, p).toFixed(6)}`).join(" ") },
  { key: "settlementRef", get: (e: AttributedEvent) => e.settlementRef },
  { key: "chainId", get: (e: AttributedEvent) => e.chainId ?? "" },
  { key: "id", get: (e: AttributedEvent) => e.id },
] as const;

/** A filename that sorts, names what is inside, and carries no spaces. */
export function exportFilename(kind: ExportKind, format: ExportFormat, nowMs: number): string {
  const stamp = iso(nowMs).replace(/[:.]/g, "-").replace("Z", "");
  return `naulon-${kind}-${stamp}.${format}`;
}

export function serializeObservations(rows: readonly ObservationEvent[], format: ExportFormat): string {
  return format === "jsonl" ? toJsonl(rows) : toCsv(rows, OBSERVATION_COLUMNS);
}

export function serializeEvents(rows: readonly AttributedEvent[], format: ExportFormat): string {
  return format === "jsonl" ? toJsonl(rows) : toCsv(rows, EVENT_COLUMNS);
}
