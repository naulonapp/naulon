/**
 * The config-sanity panel's data. The self-hoster does NOT configure articles or
 * wallets in the dashboard — that lives in their credits source (a credits.json
 * fixture or their site's /api/credits endpoint), by design (origin-native,
 * custody-free). This view just READS the effective config the gate loaded and
 * reflects it back, so the operator can confirm it's right: origin, price, which
 * slugs are tollable, which wallets get paid, and whether telemetry is on.
 */
import { readFile } from "node:fs/promises";
import { getConfig, parseCredits, resolvePayees } from "@naulon/shared";

export interface ArticleConfig {
  slug: string;
  title?: string;
  wallets: string[];
}

/**
 * Warnings carry a code, not just prose, because the Doctor has a dedicated check for
 * most of these conditions and has to know which ones it already reports itself.
 * Matching on the message text is what let the empty-fixture case render twice — once
 * as a `fail` and once as a `warn`, counted twice on a screen whose whole value is an
 * honest count. The code is the contract; the message stays free to be rewritten.
 */
export type ConfigWarningCode =
  | "observations-off"
  | "credits-api-dynamic"
  | "credits-entry-invalid"
  | "credits-empty"
  | "credits-unreadable";

export interface ConfigWarning {
  code: ConfigWarningCode;
  message: string;
}

export interface ConfigSummary {
  originUrl: string;
  priceUsdc: number;
  citationMultiplier: number;
  creditsSource: { mode: "fixture" | "api"; location: string };
  /** Per-article payout wallets — null in API mode (dynamic, can't enumerate). */
  articles: ArticleConfig[] | null;
  slugCount: number | null;
  /** Unique payout wallets across all tollable articles (fixture mode). */
  wallets: string[];
  observations: "off" | "jsonl" | "supabase";
  events: "jsonl" | "supabase";
  /** Where the jsonl events log lives (EVENTS_PATH). Meaningless under the supabase backend. */
  eventsPath: string;
  /** Operator-facing warnings — misconfig that would make the proxy quietly under-perform. */
  warnings: ConfigWarning[];
}

const titleOf = (entry: unknown): string | undefined =>
  entry && typeof entry === "object" && "title" in entry
    ? String((entry as { title?: unknown }).title ?? "") || undefined
    : undefined;

export async function summarizeConfig(): Promise<ConfigSummary> {
  const c = getConfig();
  const warnings: ConfigWarning[] = [];
  const warn = (code: ConfigWarningCode, message: string): void => {
    warnings.push({ code, message });
  };

  if (c.OBSERVATIONS_BACKEND === "off") {
    warn(
      "observations-off",
      "OBSERVATIONS_BACKEND is off — the traffic panel stays empty. Set it to jsonl to record who was served, denied, and paid.",
    );
  }

  const apiMode = !!c.CREDITS_API_URL;
  let articles: ArticleConfig[] | null = null;
  let wallets: string[] = [];

  if (apiMode) {
    // A live /credits endpoint is per-slug — there's no list to enumerate.
    warn("credits-api-dynamic", "Credits come from a live API — the article list is dynamic and not shown here.");
  } else {
    try {
      const raw = JSON.parse(await readFile(c.CREDITS_FIXTURES, "utf8")) as Record<string, unknown>;
      const walletSet = new Set<string>();
      articles = [];
      for (const [slug, entry] of Object.entries(raw)) {
        try {
          const payees = resolvePayees(parseCredits(entry, `fixture "${slug}"`));
          const w = payees.map((p) => p.wallet as string);
          w.forEach((x) => walletSet.add(x));
          articles.push({ slug, title: titleOf(entry), wallets: w });
        } catch (e) {
          warn("credits-entry-invalid", `credits entry "${slug}" is invalid: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      wallets = [...walletSet];
      if (articles.length === 0) warn("credits-empty", "The credits fixture has no articles — nothing is tollable.");
    } catch (e) {
      warn("credits-unreadable", `Could not read the credits fixture ${c.CREDITS_FIXTURES}: ${(e as Error).message}`);
    }
  }

  return {
    originUrl: c.ORIGIN_URL,
    priceUsdc: c.DEFAULT_PRICE_USDC,
    citationMultiplier: c.CITATION_MULTIPLIER,
    creditsSource: apiMode
      ? { mode: "api", location: c.CREDITS_API_URL! }
      : { mode: "fixture", location: c.CREDITS_FIXTURES },
    articles,
    slugCount: articles ? articles.length : null,
    wallets,
    observations: c.OBSERVATIONS_BACKEND,
    events: c.EVENTS_BACKEND,
    eventsPath: c.EVENTS_PATH,
    warnings,
  };
}
