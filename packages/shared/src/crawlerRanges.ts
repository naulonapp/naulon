/**
 * The merged crawler-ranges document a gate serves, and the rules that decide what goes in it.
 *
 * Three rules keep a real crawler from reading as forged when an operator's file misbehaves:
 *   - a prefix stays valid for UNION_MS after it was last seen, so a range briefly dropped from a
 *     file does not turn its crawler into an impostor;
 *   - a fetch with under SHRINK_RATIO of the last good copy's prefixes is refused, not applied;
 *   - an operator whose last good fetch is older than FRESH_MS can verify but cannot accuse.
 */
import { parseCidr, RangeSet } from "./ipRange.ts";
import type { ProofKind } from "./crawlerProof.ts";

export const UNION_MS = 30 * 86_400_000;
export const FRESH_MS = 7 * 86_400_000;
export const SHRINK_RATIO = 0.5;
/**
 * A shrunk copy served identically this many fetches running is a real change (an operator merging
 * its prefixes), not a broken file, and is applied. Without it the guard refuses a consolidation
 * forever and the operator's crawler reads unverified once the union window empties.
 */
export const SHRINK_CONFIRMATIONS = 3;

const valid = (s: unknown): s is string => typeof s === "string" && parseCidr(s) !== null;

export function parseRangeFile(body: string): string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const prefixes = (json as { prefixes?: unknown }).prefixes;
  if (!Array.isArray(prefixes)) return null;
  const out: string[] = [];
  for (const p of prefixes) {
    if (typeof p !== "object" || p === null) continue;
    const entry = p as { ipv4Prefix?: unknown; ipv6Prefix?: unknown };
    const v = entry.ipv4Prefix ?? entry.ipv6Prefix;
    if (valid(v)) out.push(v.trim());
  }
  return out.length > 0 ? out : null;
}

export function parseLineList(body: string): string[] | null {
  const out = body.split(/\r?\n/).map((l) => l.trim()).filter(valid);
  return out.length > 0 ? out : null;
}

export type SourceHealthStatus = "ok" | "redirected" | "http-error" | "bad-shape" | "shrunk" | "unreachable" | "never-fetched";

export interface SourceHealth {
  url: string;
  status: SourceHealthStatus;
  since: number;
  finalUrl?: string;
  detail?: string;
}

export interface SourceState {
  url: string;
  lastGoodAt: number | null;
  lastGoodCount: number;
  /** prefix → when it was last present in a good copy */
  seen: ReadonlyMap<string, number>;
  health: SourceHealth;
  /** The refused shrunk copy (sorted, joined) and how many fetches running have served exactly it. */
  shrunkSig?: string;
  shrunkRuns?: number;
}

export type FetchOutcome =
  | { kind: "ok"; prefixes: string[]; finalUrl: string }
  | { kind: "http-error"; status: number }
  | { kind: "bad-shape"; detail: string }
  | { kind: "unreachable"; detail: string };

export function emptySourceState(url: string, now: number): SourceState {
  return { url, lastGoodAt: null, lastGoodCount: 0, seen: new Map(), health: { url, status: "never-fetched", since: now } };
}

function nextHealth(prev: SourceHealth, status: SourceHealthStatus, now: number, extra?: Partial<SourceHealth>): SourceHealth {
  return { url: prev.url, status, since: prev.status === status ? prev.since : now, ...extra };
}

export function applyFetch(state: SourceState, out: FetchOutcome, now: number): SourceState {
  if (out.kind === "http-error") return { ...state, health: nextHealth(state.health, "http-error", now, { detail: `HTTP ${out.status}` }) };
  if (out.kind === "bad-shape") return { ...state, health: nextHealth(state.health, "bad-shape", now, { detail: out.detail }) };
  if (out.kind === "unreachable") return { ...state, health: nextHealth(state.health, "unreachable", now, { detail: out.detail }) };
  if (state.lastGoodCount > 0 && out.prefixes.length < state.lastGoodCount * SHRINK_RATIO) {
    const sig = [...out.prefixes].sort().join(",");
    const runs = state.shrunkSig === sig ? (state.shrunkRuns ?? 0) + 1 : 1;
    if (runs < SHRINK_CONFIRMATIONS) {
      return {
        ...state,
        shrunkSig: sig,
        shrunkRuns: runs,
        health: nextHealth(state.health, "shrunk", now, { detail: `${out.prefixes.length} prefixes, last good copy had ${state.lastGoodCount}` }),
      };
    }
  }
  const seen = new Map<string, number>();
  for (const [p, at] of state.seen) if (now - at <= UNION_MS) seen.set(p, at);
  for (const p of out.prefixes) seen.set(p, now);
  const redirected = out.finalUrl !== state.url;
  return {
    url: state.url,
    lastGoodAt: now,
    lastGoodCount: out.prefixes.length,
    seen,
    health: nextHealth(state.health, redirected ? "redirected" : "ok", now, redirected ? { finalUrl: out.finalUrl } : {}),
  };
}

export function unionOf(state: SourceState, now: number): string[] {
  const out: string[] = [];
  for (const [p, at] of state.seen) if (now - at <= UNION_MS) out.push(p);
  return out;
}

export interface RangesOperator {
  id: string;
  operator: string;
  fragments: string[];
  kind: ProofKind;
  forgedEligible: boolean;
  fetchedAt: string | null;
  prefixes: string[];
}

export interface CrawlerRangesDocument {
  version: 1;
  generatedAt: string;
  proxies: Record<string, string[]>;
  operators: RangesOperator[];
  sources: SourceHealth[];
}

const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const KINDS: readonly ProofKind[] = ["ranges", "signature", "none"];

export function parseRangesDocument(raw: unknown): CrawlerRangesDocument | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 1 || typeof d.generatedAt !== "string" || !Array.isArray(d.operators)) return null;
  if (typeof d.proxies !== "object" || d.proxies === null) return null;
  const proxies: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(d.proxies as Record<string, unknown>)) {
    // An empty list would read as "this proxy has no addresses", turning its own egress into a caller.
    if (!strArr(v) || v.length === 0) return null;
    proxies[k] = v;
  }
  const operators: RangesOperator[] = [];
  for (const o of d.operators as unknown[]) {
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.operator !== "string" || !strArr(r.fragments) || !strArr(r.prefixes)) return null;
    // An empty fragment is a substring of every user-agent, a person's included.
    if (r.fragments.some((f) => f.length === 0)) return null;
    if (!KINDS.includes(r.kind as ProofKind) || typeof r.forgedEligible !== "boolean") return null;
    if (r.fetchedAt !== null && typeof r.fetchedAt !== "string") return null;
    operators.push({
      id: r.id,
      operator: r.operator,
      fragments: r.fragments.map((f) => f.toLowerCase()),
      kind: r.kind as ProofKind,
      forgedEligible: r.forgedEligible,
      fetchedAt: r.fetchedAt as string | null,
      prefixes: r.prefixes,
    });
  }
  return { version: 1, generatedAt: d.generatedAt, proxies, operators, sources: Array.isArray(d.sources) ? (d.sources as SourceHealth[]) : [] };
}

export interface CompiledOperator {
  id: string;
  operator: string;
  fragments: readonly string[];
  kind: ProofKind;
  forgedEligible: boolean;
  fetchedAtMs: number | null;
  set: RangeSet;
}

export interface CompiledRanges {
  operators: ReadonlyMap<string, CompiledOperator>;
  table: readonly CompiledOperator[];
  proxies: ReadonlyMap<string, RangeSet>;
}

export function compileRanges(doc: CrawlerRangesDocument): CompiledRanges {
  const table: CompiledOperator[] = doc.operators.map((o) => {
    const ms = o.fetchedAt === null ? NaN : Date.parse(o.fetchedAt);
    return {
      id: o.id,
      operator: o.operator,
      fragments: o.fragments,
      kind: o.kind,
      forgedEligible: o.forgedEligible,
      fetchedAtMs: Number.isFinite(ms) ? ms : null,
      set: RangeSet.fromStrings(o.prefixes).set,
    };
  });
  const proxies = new Map<string, RangeSet>();
  for (const [k, v] of Object.entries(doc.proxies)) proxies.set(k, RangeSet.fromStrings(v).set);
  return { operators: new Map(table.map((o) => [o.id, o])), table, proxies };
}

export function isFresh(op: CompiledOperator, now: number): boolean {
  return op.fetchedAtMs !== null && now - op.fetchedAtMs <= FRESH_MS;
}
