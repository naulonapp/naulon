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
import { httpPublisherResolver } from "./httpPublisherResolver.ts";
import {
  getConfig,
  normalizeIncludeExtensions,
  readCrawlerPolicyFile,
  splitList,
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

/** The toll scope this gate's own config describes. Absent for prefix mode, the default. */
function gateScopeOf(cfg: Config): PublisherConfig["gateScope"] {
  if (cfg.GATE_SCOPE !== "site") return undefined;
  const include = normalizeIncludeExtensions(splitList(cfg.GATE_INCLUDE_EXTENSIONS));
  return { mode: "site", excludePrefixes: splitList(cfg.GATE_EXCLUDE_PREFIXES), ...(include.length ? { includeExtensions: include } : {}) };
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
  const articlePrefixes = splitList(cfg.ARTICLE_PATH_PREFIXES);
  const gateScope = gateScopeOf(cfg);
  const price = usdc(cfg.DEFAULT_PRICE_USDC);
  // Read once at construction, exactly as credits are: the gate loads its policy at boot
  // and a later edit takes a restart. That is the contract credits.json already has, and
  // the dashboard's restart-pending banner already exists to say so. Absent file ⇒
  // undefined ⇒ classifier defaults — the behaviour every deploy had before this existed.
  const crawlerPolicy = readCrawlerPolicyFile(cfg.CRAWLER_POLICY_PATH);

  return {
    async resolve(host: string): Promise<PublisherConfig> {
      const { policy } = await crawlerPolicy;
      return {
        id: "default",
        originUrl: cfg.ORIGIN_URL,
        articlePrefixes,
        price,
        citationMultiplier: cfg.CITATION_MULTIPLIER,
        credits: await credits,
        licenseIdentity: cfg.LICENSE_ISSUER ?? `naulon:${host}`,
        coauthorSplit: cfg.COAUTHOR_ONCHAIN_SPLIT,
        ...(policy ? { crawlerPolicy: policy } : {}),
        ...(gateScope ? { gateScope } : {}),
      };
    },
  };
}

/** True when the operator configured platform tenancy (`NAULON_PLATFORM_URL` + `NAULON_PLATFORM_KEY`). */
export function platformTenancy(cfg: Config): boolean {
  return cfg.NAULON_PLATFORM_URL !== undefined && cfg.NAULON_PLATFORM_KEY !== undefined;
}

/**
 * The resolver a gate boots with when none is injected: the platform's records when platform
 * tenancy is configured, otherwise the single publisher described by this gate's own config.
 */
export function defaultPublisherResolver(cfg: Config = getConfig()): PublisherResolver {
  if (cfg.NAULON_PLATFORM_URL !== undefined && cfg.NAULON_PLATFORM_KEY !== undefined) {
    return httpPublisherResolver({ url: cfg.NAULON_PLATFORM_URL, key: cfg.NAULON_PLATFORM_KEY });
  }
  return envPublisherResolver(cfg);
}
