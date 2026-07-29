/**
 * The crawler-policy plane for the self-host console — read the policy the gate loaded,
 * and write a new one.
 *
 * Why this exists: `decide()` has always enforced `PublisherConfig.crawlerPolicy`, and
 * the open core never gave anyone a way to author one. A self-hoster who wanted to
 * refuse a scraper had to write their own `PublisherResolver`. So the gate shipped a
 * feature nobody could reach.
 *
 * Validation is `normalizeCrawlerPolicy` from `@naulon/shared` — the same function the
 * gate's own type lives beside, not a copy. That matters most for one check: a `block`
 * fragment like "mozilla" would 403 every human reader, and humans read free is a
 * promise, not a preference. A second implementation of that guard is a second chance
 * to not have it.
 */
import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CRAWLER_REGISTRY,
  getConfig,
  isPolicyEmpty,
  normalizeCrawlerPolicy,
  readCrawlerPolicyFile,
  type CrawlerPolicy,
  type RegistryCrawler,
} from "@naulon/shared";

/** What a crawler's policy resolves to. `default` = no rule; the classifier decides. */
export type CrawlerState = "default" | "allow" | "charge" | "block";

export interface CrawlerRow extends RegistryCrawler {
  state: CrawlerState;
  /** What happens today if the operator leaves this on `default`. */
  defaultState: "free" | "charged";
}

export interface CrawlersView {
  /** Where the policy lives on disk. */
  path: string;
  /** True when no policy file exists yet — the normal state, not an error. */
  absent: boolean;
  /** Set when a file exists but could not be used; the gate is serving open meanwhile. */
  problem: string | null;
  policy: CrawlerPolicy;
  /** True when the policy would change no decision. */
  empty: boolean;
  /** The curated list, each with its resolved state. */
  crawlers: CrawlerRow[];
  /** Fragments the operator typed that are not in the registry. */
  custom: { fragment: string; state: Exclude<CrawlerState, "default"> }[];
  /** mtime of the policy file, for the restart-drift check. */
  fileModifiedAt: number | null;
}

const stateOf = (fragment: string, p: CrawlerPolicy): CrawlerState =>
  // Block first: it wins over allow on overlap in the gate too (fail-safe), so reading
  // it in any other order would show a state the gate would not apply.
  p.block.includes(fragment)
    ? "block"
    : (p.charge ?? []).includes(fragment)
      ? "charge"
      : p.allow.includes(fragment)
        ? "allow"
        : "default";

/** Read the policy on disk and project it over the curated registry. */
export async function readCrawlers(path?: string): Promise<CrawlersView> {
  const cfg = getConfig();
  const file = path ?? cfg.CRAWLER_POLICY_PATH;
  const { policy, problem, absent } = await readCrawlerPolicyFile(file);
  const p: CrawlerPolicy = policy ?? { allow: [], block: [] };

  const known = new Set(CRAWLER_REGISTRY.map((c) => c.fragment));
  const custom: CrawlersView["custom"] = [];
  for (const [state, list] of [
    ["allow", p.allow],
    ["charge", p.charge ?? []],
    ["block", p.block],
  ] as const) {
    for (const fragment of list) {
      if (!known.has(fragment)) custom.push({ fragment, state });
    }
  }

  let fileModifiedAt: number | null = null;
  if (!absent) {
    try {
      fileModifiedAt = (await stat(file)).mtimeMs;
    } catch {
      fileModifiedAt = null;
    }
  }

  return {
    path: file,
    absent,
    problem,
    policy: p,
    empty: isPolicyEmpty(policy),
    crawlers: CRAWLER_REGISTRY.map((c) => ({
      ...c,
      state: stateOf(c.fragment, p),
      defaultState: c.defaultCharged ? "charged" : "free",
    })),
    custom,
    fileModifiedAt,
  };
}

export interface WriteResult {
  written: boolean;
  /** The validator's sentence, verbatim — it already explains itself to an operator. */
  error?: string;
  policy?: CrawlerPolicy;
}

/**
 * Validate and persist. Nothing is written unless `normalizeCrawlerPolicy` accepts the
 * whole policy, so a refusal never leaves a half-applied file behind — and the file the
 * gate reads at boot is therefore always one the validator passed.
 */
export async function writeCrawlers(
  input: { allow?: unknown; block?: unknown; charge?: unknown },
  path?: string,
): Promise<WriteResult> {
  const cfg = getConfig();
  const file = path ?? cfg.CRAWLER_POLICY_PATH;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const charge = list(input.charge);
  let policy: CrawlerPolicy;
  try {
    policy = normalizeCrawlerPolicy({
      allow: list(input.allow),
      block: list(input.block),
      ...(charge.length > 0 ? { charge } : {}),
    });
  } catch (e) {
    return { written: false, error: (e as Error).message };
  }

  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(policy, null, 2) + "\n", "utf8");
  } catch (e) {
    return { written: false, error: `Could not write ${file}: ${(e as Error).message}` };
  }
  return { written: true, policy };
}

/**
 * The gate read this file at boot, so an edit since then is saved but not enforced —
 * the same drift `content.ts` reports for credits.json, and the same remedy (restart).
 * Deliberately shares that vocabulary rather than inventing a second one.
 */
export function isPolicyRestartPending(input: {
  fileModifiedAt: number | null;
  gateStartedAt: string | null;
  gateUp: boolean;
}): boolean {
  if (!input.gateUp || input.fileModifiedAt === null || !input.gateStartedAt) return false;
  const started = Date.parse(input.gateStartedAt);
  return Number.isFinite(started) && input.fileModifiedAt > started;
}
