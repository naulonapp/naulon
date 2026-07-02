/**
 * The single-tenant reference resolver — the open-source default impl of the
 * `PublisherResolver` seam (interface in `@naulon/shared`).
 *
 * It builds exactly one `PublisherConfig` from env and answers EVERY host with it —
 * the single-tenant gate. A downstream service can swap this for its own resolver
 * and inject it via `createApp(resolver)` to front a different publisher; the gate
 * core is unchanged.
 *
 * The credits-resolver selection (live API vs. local fixture) lives here because
 * it's a property of *this* impl, not of the protocol: another resolver may carry
 * its publisher's credits source straight from its own database.
 */
import {
  getConfig,
  usdc,
  type Config,
  type CreditsResolver,
  type PublisherConfig,
  type PublisherResolver,
} from "@naulon/shared";
import { fixtureResolverFromFile, httpResolver } from "./credits.ts";

/** Pick the credits resolver: a live credits API if configured, else fixtures. */
function buildCreditsResolver(cfg: Config): Promise<CreditsResolver> {
  if (cfg.CREDITS_API_URL) {
    return Promise.resolve(httpResolver(cfg.CREDITS_API_URL, cfg.CREDITS_API_TOKEN));
  }
  return fixtureResolverFromFile(cfg.CREDITS_FIXTURES);
}

/** Split `ARTICLE_PATH_PREFIXES` into clean prefixes (no leading slash, no blanks). */
function parsePrefixes(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Build the single-tenant resolver from config. The host-independent pieces (the
 * credits resolver's file read, the parsed prefixes, the validated price) are
 * computed once and reused; only `licenseIdentity` is derived per call, because
 * absent a `LICENSE_ISSUER` override it tracks the request host — preserving the
 * pre-seam behavior where each host signs as `naulon:<that host>`.
 */
export function envPublisherResolver(cfg: Config = getConfig()): PublisherResolver {
  const credits = buildCreditsResolver(cfg);
  const articlePrefixes = parsePrefixes(cfg.ARTICLE_PATH_PREFIXES);
  const price = usdc(cfg.DEFAULT_PRICE_USDC);

  return {
    async resolve(host: string): Promise<PublisherConfig> {
      return {
        id: "default",
        originUrl: cfg.ORIGIN_URL,
        articlePrefixes,
        price,
        citationMultiplier: cfg.CITATION_MULTIPLIER,
        credits: await credits,
        licenseIdentity: cfg.LICENSE_ISSUER ?? `naulon:${host}`,
        settlementSecret: cfg.CREDITS_SETTLEMENT_SECRET,
        coauthorSplit: cfg.COAUTHOR_ONCHAIN_SPLIT,
      };
    },
  };
}
