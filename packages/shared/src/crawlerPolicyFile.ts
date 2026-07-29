/**
 * Read a `CrawlerPolicy` off disk for the single-tenant gate.
 *
 * The gate has always enforced `PublisherConfig.crawlerPolicy` — `decide()` refuses a
 * blocked fragment before it even classifies — but nothing in the open core ever
 * WROTE one, so `envPublisherResolver` returned a config with the field absent and a
 * self-hoster's only route to a blocklist was implementing their own resolver. This is
 * the missing half.
 *
 * Failure posture is deliberately quiet-and-open: a missing file, malformed JSON, or a
 * policy the validator refuses all resolve to `undefined`, which means "classifier
 * defaults" — exactly what every deploy has today. The alternative, failing the boot,
 * would let a typo in an optional file take a publisher's whole site offline. A refusal
 * is reported through `readCrawlerPolicyFile`'s `problem` so a console can show it;
 * the serving path just carries on.
 */
import { readFile } from "node:fs/promises";
import type { CrawlerPolicy } from "./publisher.ts";
import { normalizeCrawlerPolicy } from "./crawler-policy.ts";

export interface CrawlerPolicyFileResult {
  /** The validated policy, or undefined when there is none to apply. */
  policy: CrawlerPolicy | undefined;
  /** Why there is none, when that is worth telling the operator. `null` when all is well. */
  problem: string | null;
  /** True when the file simply does not exist — the normal state, not an error. */
  absent: boolean;
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Read + validate. Never throws; every failure mode is reported in the result. */
export async function readCrawlerPolicyFile(path: string): Promise<CrawlerPolicyFileResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { policy: undefined, problem: null, absent: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { policy: undefined, problem: `${path} is not valid JSON: ${(e as Error).message}`, absent: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { policy: undefined, problem: `${path} must be a JSON object with allow/block/charge arrays`, absent: false };
  }

  const o = parsed as Record<string, unknown>;
  const charge = asList(o["charge"]);
  try {
    return {
      policy: normalizeCrawlerPolicy({
        allow: asList(o["allow"]),
        block: asList(o["block"]),
        ...(charge.length > 0 ? { charge } : {}),
      }),
      problem: null,
      absent: false,
    };
  } catch (e) {
    // The validator refused — most often the humans-read-free guard. Serve open and say so.
    return { policy: undefined, problem: `${path} was refused: ${(e as Error).message}`, absent: false };
  }
}

/** True when a policy would actually change any decision. An all-empty policy would not. */
export function isPolicyEmpty(p: CrawlerPolicy | undefined): boolean {
  return !p || (p.allow.length === 0 && p.block.length === 0 && (p.charge ?? []).length === 0);
}
