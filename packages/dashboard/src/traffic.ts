/**
 * The traffic plane — the real tail of what happened at the gate, and the rollups
 * that turn it into an answer.
 *
 * `ops.ts` already summarises traffic for the Overview's counters, and deliberately
 * stays a summary: six verdict totals, an identity split, two money figures. This
 * module is the layer under the questions that summary cannot answer — *which* path
 * earns, *which* crawler takes free, and what the money left on the table is
 * actually made of. Both read the same `ObservationEvent[]`; neither re-derives the
 * other's figures.
 *
 * Everything here is pure: observations and a clock in, plain data out. No fs, no
 * config, no Date.now — so every branch is testable without a gate or a log file.
 */
import { agentKey, OBSERVATION_VERDICTS, registryCrawler } from "@naulon/shared";
import type { ObservationEvent, ObservationVerdict } from "@naulon/shared";

/** How an agent's identity was established. The Agents page is built on this split. */
export type AgentIdentity =
  /** Web Bot Auth signature verified (RFC 9421) — we know who this is. */
  | "verified"
  /** No signature presented. The default for most crawlers today. */
  | "unsigned"
  /** A signature WAS presented and failed. Not a mistake — someone claiming to be
   *  a signer they are not. Kept separate from `unsigned` for exactly that reason. */
  | "masquerade";

export interface TrafficQuery {
  /** Only observations at or after this epoch-ms. */
  since: number;
  /** Restrict to one verdict. Undefined = all six. */
  verdict?: ObservationVerdict | undefined;
  /** Case-insensitive substring over slug, host, user-agent and verified agent. */
  q?: string | undefined;
  /** Restrict to one outcome group. */
  outcome?: Outcome | undefined;
  /** Restrict to one agent, by the key it rolls up under. */
  agent?: string | undefined;
  /** Restrict to one path (slug). */
  slug?: string | undefined;
  /** Restrict to one way of proving identity. */
  identity?: AgentIdentity | undefined;
}

/** One row of the "which path" rollup — money earned and money missed, per slug. */
export interface PathRow {
  slug: string;
  requests: number;
  paid: number;
  denied: number;
  paymentFailed: number;
  servedFree: number;
  /** USDC captured on this path. */
  earned: number;
  /** USDC quoted and not collected (denied + payment-failed). */
  missed: number;
}

/** One row of the "who" rollup. Identity is the strongest seen for that key. */
export interface AgentRow {
  /** The key it rolls up under (`agentKeyOf`). Never empty. */
  agent: string;
  identity: AgentIdentity;
  /** The crawler registry's company and purpose, when the registry names it. */
  operator?: string;
  purpose?: string;
  requests: number;
  paid: number;
  denied: number;
  paymentFailed: number;
  blocked: number;
  /** A good payment declined because the origin could not serve the read. */
  unservable: number;
  /** Reads taken without paying: served-free + agent-reread. */
  free: number;
  earned: number;
  missed: number;
  lastAt: number;
}

/**
 * Missed earnings split by CAUSE. The two causes are different problems with
 * different fixes — `denied` is an agent that saw the price and walked, which is the
 * toll working; `payment-failed` is an agent that TRIED to pay and could not, which
 * is money lost to a fault on one side or the other. Rolling them into one "missed"
 * figure hides the second inside the first.
 */
export interface MissedByCause {
  denied: { requests: number; usdc: number };
  paymentFailed: { requests: number; usdc: number };
  /** Per-path, worst first. Only paths that missed something appear. */
  byPath: { slug: string; denied: number; deniedUsdc: number; paymentFailed: number; paymentFailedUsdc: number }[];
}

/** Where a page of rows starts: strictly after this row in (at desc, id desc) order. */
export interface RowCursor {
  at: number;
  id: string;
}

/** Whose requests the row list holds. Every rollup is about agents; the list is too by default. */
export type Who = "agent" | "human" | "all";

export function parseWho(v: string | undefined): Who {
  return v === "human" || v === "all" ? v : "agent";
}

export interface TrafficReport {
  at: number;
  since: number;
  /** One page of the rows matching the filter, newest first, each with the key it rolls up under. */
  rows: Array<ObservationEvent & { agent: string }>;
  /** How many rows the list holds in all, before paging, so a page can say "of N". */
  matched: number;
  /** Where the next older page starts, or null at the end. */
  next: RowCursor | null;
  /** Agent requests by outcome, the Requests page's ribbon. */
  outcomes: Record<Outcome, number>;
  /** USDC taken on paid requests, and quoted to agents that walked away: what the page leads with. */
  money: { earned: number; missed: number };
  /** Agent requests by weekday and hour, UTC: `heatmap[weekday][hour]`, Sunday = 0. */
  heatmap: number[][];
  /** Verdict counts across the MATCHED set (i.e. after the filter). */
  byVerdict: Record<ObservationVerdict, number>;
  topPaths: PathRow[];
  topAgents: AgentRow[];
  missed: MissedByCause;
}

/** Re-exported from shared, never re-typed. A local copy of this list is what silently dropped
 *  `unservable` from every bar while it still counted toward the total. */
export const VERDICTS: readonly ObservationVerdict[] = OBSERVATION_VERDICTS;

/** Narrow an untrusted query value to a verdict, or undefined. */
export function parseVerdict(v: string | undefined): ObservationVerdict | undefined {
  return v && (VERDICTS as readonly string[]).includes(v) ? (v as ObservationVerdict) : undefined;
}

const zeroVerdicts = (): Record<ObservationVerdict, number> =>
  Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<ObservationVerdict, number>;

/**
 * The identity of one observation's caller. `sigInvalid` is checked BEFORE the
 * unsigned fallback: a failed signature is a claim, and a claim that fails must never
 * be filed under "didn't claim anything".
 */
export function identityOf(o: ObservationEvent): AgentIdentity {
  if (o.verified) return "verified";
  if (o.sigInvalid) return "masquerade";
  return "unsigned";
}

/**
 * The key an agent rolls up under: `agentKey` from shared, the same rule the hosted audit uses. A
 * verified caller groups by its directory host; a known crawler by its registry name however its UA
 * string is spelled; anything else by its raw UA, spoofable and labelled as such by `identity`.
 * Keying on the raw UA split one crawler into a row per spelling.
 */
export const agentKeyOf = (o: ObservationEvent): string => agentKey(o);

/** The four outcomes a toll decision falls into, as the Requests page shows them. */
export type Outcome = "paid" | "left" | "free" | "refused";
export const OUTCOMES: readonly Outcome[] = ["paid", "left", "free", "refused"];

export function outcomeOf(v: ObservationVerdict): Outcome {
  switch (v) {
    case "paid":
      return "paid";
    case "denied":
      return "left";
    case "served-free":
    case "agent-reread":
      return "free";
    case "blocked":
    case "payment-failed":
    case "unservable":
      return "refused";
    default: {
      const unhandled: never = v;
      return unhandled;
    }
  }
}

export function parseOutcome(v: string | undefined): Outcome | undefined {
  return v && (OUTCOMES as readonly string[]).includes(v) ? (v as Outcome) : undefined;
}

export function parseIdentity(v: string | undefined): AgentIdentity | undefined {
  return v === "verified" || v === "unsigned" || v === "masquerade" ? v : undefined;
}

/** Case-insensitive substring across every field an operator would search by. */
function matchesQuery(o: ObservationEvent, needle: string): boolean {
  const hay = `${o.slug} ${o.path ?? ""} ${o.host} ${agentKeyOf(o)} ${o.agentUa ?? ""} ${o.verifiedAgent ?? ""} ${o.classifyReason ?? ""} ${o.referrerHost ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

/** Apply the window + verdict + text filter. Pure; input order is preserved. */
export function filterObservations(observations: readonly ObservationEvent[], q: TrafficQuery): ObservationEvent[] {
  const needle = q.q?.trim().toLowerCase();
  return observations.filter((o) => {
    if (o.at < q.since) return false;
    if (q.verdict && o.verdict !== q.verdict) return false;
    if (q.outcome && outcomeOf(o.verdict) !== q.outcome) return false;
    if (q.agent && agentKeyOf(o) !== q.agent) return false;
    if (q.slug !== undefined && o.slug !== q.slug) return false;
    if (q.identity && (o.classifiedAs !== "agent" || identityOf(o) !== q.identity)) return false;
    if (needle && !matchesQuery(o, needle)) return false;
    return true;
  });
}

/**
 * Money per path. `price` is what the gate QUOTED, so it is the earned figure on a
 * `paid` and the missed figure on a `denied` / `payment-failed` — the same number
 * meaning two different things depending on the verdict, which is the whole point of
 * keeping the columns apart.
 */
export function rollupPaths(observations: readonly ObservationEvent[]): PathRow[] {
  const rows = new Map<string, PathRow>();
  for (const o of observations) {
    const slug = o.slug || "(non-article)";
    let row = rows.get(slug);
    if (!row) {
      row = { slug, requests: 0, paid: 0, denied: 0, paymentFailed: 0, servedFree: 0, earned: 0, missed: 0 };
      rows.set(slug, row);
    }
    row.requests += 1;
    const price = o.price ?? 0;
    if (o.verdict === "paid") {
      row.paid += 1;
      row.earned += price;
    } else if (o.verdict === "denied") {
      row.denied += 1;
      row.missed += price;
    } else if (o.verdict === "payment-failed") {
      row.paymentFailed += 1;
      row.missed += price;
    } else if (o.verdict === "served-free" || o.verdict === "agent-reread") {
      row.servedFree += 1;
    }
  }
  // Money first — the operator's question is "what earns", not "what is busy". Requests
  // break the tie so a path with traffic and no money still outranks a silent one.
  return [...rows.values()].sort(
    (a, b) => b.earned - a.earned || b.missed - a.missed || b.requests - a.requests || a.slug.localeCompare(b.slug),
  );
}

/**
 * Who took what. Humans are excluded — they read free by design (the gate's standing
 * promise), so listing them here would pad the table with the one population the
 * operator is never meant to act on.
 */
export function rollupAgents(observations: readonly ObservationEvent[]): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const o of observations) {
    if (o.classifiedAs !== "agent") continue;
    const agent = agentKeyOf(o);
    let row = rows.get(agent);
    if (!row) {
      const reg = registryCrawler(o);
      row = {
        agent,
        identity: identityOf(o),
        ...(reg ? { operator: reg.operator, purpose: reg.category } : {}),
        requests: 0,
        paid: 0,
        denied: 0,
        paymentFailed: 0,
        blocked: 0,
        unservable: 0,
        free: 0,
        earned: 0,
        missed: 0,
        lastAt: o.at,
      };
      rows.set(agent, row);
    }
    // Strongest claim wins the label: one verified request proves the key, and one
    // failed signature is worth surfacing even among otherwise-clean traffic.
    const seen = identityOf(o);
    if (seen === "verified") row.identity = "verified";
    else if (seen === "masquerade" && row.identity !== "verified") row.identity = "masquerade";

    row.requests += 1;
    if (o.at > row.lastAt) row.lastAt = o.at;
    const price = o.price ?? 0;
    // Exhaustive: an outcome with no column raised `requests` and nothing else, so a row could not
    // add up to its own total. `unservable` was that outcome.
    switch (o.verdict) {
      case "paid":
        row.paid += 1;
        row.earned += price;
        break;
      case "denied":
        row.denied += 1;
        row.missed += price;
        break;
      case "payment-failed":
        row.paymentFailed += 1;
        row.missed += price;
        break;
      case "blocked":
        row.blocked += 1;
        break;
      case "unservable":
        row.unservable += 1;
        break;
      case "served-free":
      case "agent-reread":
        row.free += 1;
        break;
      default: {
        const unhandled: never = o.verdict;
        void unhandled;
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.earned - a.earned || b.missed - a.missed || b.requests - a.requests || a.agent.localeCompare(b.agent),
  );
}

/** Split what was left on the table by cause, overall and per path. */
export function missedByCause(observations: readonly ObservationEvent[]): MissedByCause {
  const out: MissedByCause = {
    denied: { requests: 0, usdc: 0 },
    paymentFailed: { requests: 0, usdc: 0 },
    byPath: [],
  };
  const paths = new Map<string, MissedByCause["byPath"][number]>();
  for (const o of observations) {
    if (o.verdict !== "denied" && o.verdict !== "payment-failed") continue;
    const slug = o.slug || "(non-article)";
    let row = paths.get(slug);
    if (!row) {
      row = { slug, denied: 0, deniedUsdc: 0, paymentFailed: 0, paymentFailedUsdc: 0 };
      paths.set(slug, row);
    }
    const price = o.price ?? 0;
    if (o.verdict === "denied") {
      out.denied.requests += 1;
      out.denied.usdc += price;
      row.denied += 1;
      row.deniedUsdc += price;
    } else {
      out.paymentFailed.requests += 1;
      out.paymentFailed.usdc += price;
      row.paymentFailed += 1;
      row.paymentFailedUsdc += price;
    }
  }
  out.byPath = [...paths.values()].sort(
    (a, b) => b.deniedUsdc + b.paymentFailedUsdc - (a.deniedUsdc + a.paymentFailedUsdc) || a.slug.localeCompare(b.slug),
  );
  return out;
}

export interface TrafficOptions {
  /** Rows per page. The report still carries `matched`, so a page never reads as the whole. */
  rowLimit?: number;
  /** Cap on rollup rows. */
  rollupLimit?: number;
  /** Start after this row (the `next` of the previous page). */
  after?: RowCursor | null;
  /** Whose requests the row list holds. */
  who?: Who;
}

/** Newest first, rows sharing a millisecond ordered by id, so a page edge inside such a run
 *  neither repeats nor skips a row. */
const newestFirst = (a: ObservationEvent, b: ObservationEvent): number =>
  b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** One page of rows after `after`, and where the next one starts. */
export function pageRows(
  rows: readonly ObservationEvent[],
  limit: number,
  after: RowCursor | null = null,
): { page: ObservationEvent[]; next: RowCursor | null } {
  const sorted = [...rows].sort(newestFirst);
  const start = after ? sorted.filter((r) => r.at < after.at || (r.at === after.at && r.id < after.id)) : sorted;
  const page = start.slice(0, limit);
  const last = page[page.length - 1];
  return { page, next: start.length > limit && last ? { at: last.at, id: last.id } : null };
}

/** Agent requests by weekday × hour in UTC, the console's one clock. */
export function heatmapOf(observations: readonly ObservationEvent[]): number[][] {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const o of observations) {
    if (o.classifiedAs !== "agent") continue;
    const d = new Date(o.at);
    cells[d.getUTCDay()]![d.getUTCHours()]! += 1;
  }
  return cells;
}

/** The whole traffic answer for one filter, in one pass over the log. */
export function buildTraffic(
  observations: readonly ObservationEvent[],
  query: TrafficQuery,
  nowMs: number,
  opts: TrafficOptions = {},
): TrafficReport {
  const rowLimit = opts.rowLimit ?? 50;
  const rollupLimit = opts.rollupLimit ?? 10;
  const who = opts.who ?? "agent";
  const matched = filterObservations(observations, query);

  const byVerdict = zeroVerdicts();
  const outcomes: Record<Outcome, number> = { paid: 0, left: 0, free: 0, refused: 0 };
  const money = { earned: 0, missed: 0 };
  for (const o of matched) {
    if (o.verdict in byVerdict) byVerdict[o.verdict] += 1;
    if (o.classifiedAs === "agent") outcomes[outcomeOf(o.verdict)] += 1;
    if (o.verdict === "paid") money.earned += o.price ?? 0;
    if (o.verdict === "denied") money.missed += o.price ?? 0;
  }
  const listed = who === "all" ? matched : matched.filter((o) => o.classifiedAs === who);
  const { page, next } = pageRows(listed, rowLimit, opts.after ?? null);

  return {
    at: nowMs,
    since: query.since,
    rows: page.map((o) => ({ ...o, agent: agentKeyOf(o) })),
    matched: listed.length,
    next,
    outcomes,
    money,
    heatmap: heatmapOf(matched),
    byVerdict,
    topPaths: rollupPaths(matched).slice(0, rollupLimit),
    topAgents: rollupAgents(matched).slice(0, rollupLimit),
    missed: missedByCause(matched),
  };
}

/** The Agents page's payload: the identity split plus every agent seen in the window. */
export interface AgentsReport {
  at: number;
  since: number;
  /** `forged` counts crawler claims from outside the operator's published ranges over every row:
   *  an impostor on an unarmed site read free and is recorded as a person. */
  split: { total: number; verified: number; unsigned: number; masquerade: number; forged: number };
  agents: AgentRow[];
}

export function buildAgents(
  observations: readonly ObservationEvent[],
  query: TrafficQuery,
  nowMs: number,
): AgentsReport {
  const matched = filterObservations(observations, query);
  const agents = rollupAgents(matched);
  const split = { total: 0, verified: 0, unsigned: 0, masquerade: 0, forged: 0 };
  for (const o of matched) {
    if (o.identityCheck === "forged") split.forged += 1;
    if (o.classifiedAs !== "agent") continue;
    split.total += 1;
    split[identityOf(o)] += 1;
  }
  return { at: nowMs, since: query.since, split, agents };
}
