/**
 * crawl/testing.ts — the adapter CONFORMANCE KIT.
 *
 * `SourceAdapter` is an interface, so TypeScript proves an adapter has the right SHAPE. Nothing
 * proves it has the right BEHAVIOUR — that it only touches the verified origin, that it never
 * keys an article itself, that it never puts a wallet in the catalog plane. Those are the
 * invariants that make the crawler safe to point at a stranger's site, and they are exactly the
 * ones a new adapter gets wrong.
 *
 * So the contract ships with an executable form of itself. A host with its own adapters — a
 * private one, a hosted pipeline, a connector someone wrote this afternoon — runs THIS suite
 * against them and finds out whether they are really adapters, or only shaped like one. Same
 * bargain as dbt's adapter tests and Airbyte's acceptance tests: the interface is public so the
 * implementations do not have to be.
 *
 * The kit supplies the network. An adapter under test is handed a RECORDING fetcher and can
 * reach nothing else, so "it only fetches the origin" is measured, not promised.
 *
 * ```ts
 * import { runConformance, assertConformance } from "@naulon/sdk/crawl/testing";
 *
 * test("my adapter honours the crawl contract", async () => {
 *   assertConformance(await runConformance(myAdapter, {
 *     origin: "https://site.com",
 *     routes: { "/wp-json/wp/v2/posts?per_page=1": "[]" },
 *   }));
 * });
 * ```
 */
import type {
  AdapterContext,
  ArticleCandidate,
  CrawlConfig,
  Fetcher,
  FetchResult,
  HostCapabilities,
  SourceAdapter,
} from "./types.ts";
import { canRun } from "./registry.ts";

/** A canned response: a body (200) or an explicit status. */
export type Route = string | { status: number; body?: string };

export interface ConformanceFixtures {
  /** The verified origin the adapter is pointed at. */
  origin: string;
  /** Gateable prefixes handed to the adapter (it may read them; it may not key with them). */
  articlePrefixes?: string[];
  /** Overrides merged into the crawl policy. */
  config?: Partial<CrawlConfig>;
  /** `path[?search]` on the verified origin → response. Anything unlisted answers 404. */
  routes: Record<string, Route>;
  /** Absolute URL → response, for adapters declaring `requires.offOrigin`. Reached only through
   *  the granted off-origin fetcher, never through `ctx.fetch`. */
  offOriginRoutes?: Record<string, Route>;
  /** What the host grants. A `requires.secret` adapter needs one here or it cannot be tested. */
  capabilities?: HostCapabilities;
  /** Minimum candidates `discover` must return on these fixtures. Default 1 — an adapter that
   *  finds nothing on its own happy-path fixture is not being tested. */
  minCandidates?: number;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  /** Why it failed, with the observed value. Absent when `ok`. */
  detail?: string;
}

export interface ConformanceReport {
  adapterId: string;
  passed: boolean;
  checks: ConformanceCheck[];
  /** Every URL the adapter requested, in order — useful when a check fails. */
  requested: string[];
}

const EVM_ADDRESS = /0x[0-9a-fA-F]{40}/;

function respond(hit: Route | undefined): FetchResult {
  const status = hit === undefined ? 404 : typeof hit === "string" ? 200 : hit.status;
  const body = hit === undefined ? "" : typeof hit === "string" ? hit : (hit.body ?? "");
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body) as unknown;
    },
  };
}

/** Any EVM address anywhere in a candidate — the money-is-never-inferred tripwire. */
function containsWallet(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (typeof value === "string") return EVM_ADDRESS.test(value);
  if (Array.isArray(value)) return value.some((v) => containsWallet(v, depth + 1));
  if (typeof value === "object") return Object.values(value).some((v) => containsWallet(v, depth + 1));
  return false;
}

/**
 * Run the contract against one adapter and report every check.
 *
 * Never throws for a failing adapter — a failure is a check with `ok: false`, so a caller can
 * print the whole picture instead of the first thing that broke. `assertConformance` is the
 * throwing wrapper for use inside a test.
 */
export async function runConformance(
  adapter: SourceAdapter<string>,
  fixtures: ConformanceFixtures,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const requested: string[] = [];
  const offOriginRequested: string[] = [];
  const originHost = new URL(fixtures.origin).host;

  const add = (name: string, ok: boolean, detail?: string) => checks.push(ok ? { name, ok } : { name, ok, detail });

  /* ── static shape ──────────────────────────────────────────────────────────── */

  add("id is a non-empty string", typeof adapter.id === "string" && adapter.id.length > 0, `id=${String(adapter.id)}`);
  add("rank is a finite number", Number.isFinite(adapter.rank), `rank=${String(adapter.rank)}`);

  const offOrigin = adapter.requires?.offOrigin ?? [];
  add(
    "declared off-origin hosts are bare hostnames",
    offOrigin.every((h) => /^[a-z0-9.-]+$/i.test(h) && !h.includes("*") && !h.includes("/")),
    `offOrigin=${JSON.stringify(offOrigin)} — a wildcard or a path here means the allowlist is not fixed`,
  );

  add(
    "requirements are honest: an ungranted adapter is refused",
    !adapter.requires?.secret || canRun(adapter, {}) === false,
    "declares requires.secret but canRun() accepts a host granting none",
  );

  /* ── the network the adapter is allowed ────────────────────────────────────── */

  const fetch: Fetcher = async (url) => {
    requested.push(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return respond(undefined);
    }
    if (parsed.host !== originHost) return respond(undefined); // recorded, and refused
    const withSearch = parsed.pathname + parsed.search;
    const hit = fixtures.routes[withSearch] ?? fixtures.routes[parsed.pathname];
    return respond(hit);
  };

  const offOriginFetch: Fetcher | undefined = fixtures.capabilities?.offOriginFetch
    ? undefined // caller supplied their own; we cannot record through it
    : offOrigin.length > 0
      ? async (url) => {
          offOriginRequested.push(url);
          return respond(fixtures.offOriginRoutes?.[url]);
        }
      : undefined;

  const capabilities: HostCapabilities = {
    ...fixtures.capabilities,
    ...(offOriginFetch ? { offOriginFetch } : {}),
  };

  const config: CrawlConfig = {
    includeGlobs: [],
    excludeGlobs: [],
    authorWalletMap: {},
    ...fixtures.config,
  };

  const ctx: AdapterContext = {
    origin: fixtures.origin,
    articlePrefixes: fixtures.articlePrefixes ?? ["articles"],
    config,
    fetch,
    capabilities,
  };

  /* ── detect ────────────────────────────────────────────────────────────────── */

  let detected: boolean | null = null;
  try {
    detected = await adapter.detect(ctx);
    add("detect returns a boolean", typeof detected === "boolean", `returned ${typeof detected}`);
  } catch (e) {
    add("detect never throws on a normal probe", false, `threw ${String(e)}`);
  }

  // A dead network must read as "no", not as a crash: `selectAdapter` probes every adapter on
  // every site, so one hostile origin would otherwise take down the whole crawl. Every granted
  // fetcher fails here, not just the origin one — an adapter that probes its platform API is
  // just as exposed to a bad day at that host.
  const refuse: Fetcher = async () => {
    throw new Error("connection refused");
  };
  const deadCtx: AdapterContext = {
    ...ctx,
    fetch: refuse,
    capabilities: { ...capabilities, ...(capabilities.offOriginFetch ? { offOriginFetch: refuse } : {}) },
  };
  try {
    const onDead = await adapter.detect(deadCtx);
    add("detect never throws when the network is unreachable", true);
    // Only an on-origin adapter can be held to "false" here. One that detects through a declared
    // off-origin API may legitimately answer without touching the publisher's host at all.
    if (offOrigin.length === 0) {
      add("detect returns false when the origin is unreachable", onDead === false, `returned ${String(onDead)}`);
    }
  } catch (e) {
    add("detect never throws when the network is unreachable", false, `threw ${String(e)}`);
  }

  /* ── discover ──────────────────────────────────────────────────────────────── */

  let candidates: ArticleCandidate[] = [];
  if (detected === true) {
    try {
      candidates = await adapter.discover(ctx);
      add("discover returns an array", Array.isArray(candidates), `returned ${typeof candidates}`);
    } catch (e) {
      add("discover completes on its own happy-path fixture", false, `threw ${String(e)}`);
    }
  } else {
    add("detect is true on the happy-path fixture", false, "detect returned false — fixtures do not exercise discover");
  }

  const min = fixtures.minCandidates ?? 1;
  add("discover finds candidates on the happy-path fixture", candidates.length >= min, `found ${candidates.length}, expected >= ${min}`);

  add(
    "every candidate URL is absolute and on the verified origin",
    candidates.every((c) => {
      try {
        return new URL(c.url).host === originHost;
      } catch {
        return false;
      }
    }),
    `offending=${JSON.stringify(candidates.filter((c) => { try { return new URL(c.url).host !== originHost; } catch { return true; } }).map((c) => c.url).slice(0, 3))}`,
  );

  add(
    "candidates carry no slug — keying belongs to the orchestrator",
    candidates.every((c) => !("slug" in (c as object))),
    "a candidate carried a `slug`; deriveSlug is the orchestrator's call, not the adapter's",
  );

  add(
    "no candidate carries a wallet — money is never inferred",
    !candidates.some((c) => containsWallet(c)),
    "an EVM address appeared in a discovered candidate",
  );

  add(
    "every candidate has a string title (possibly empty)",
    candidates.every((c) => typeof c.title === "string"),
    "a candidate had a non-string title",
  );

  add(
    "every candidate has an authors array of named strings",
    candidates.every((c) => Array.isArray(c.authors) && c.authors.every((a) => typeof a.name === "string" && a.name.length > 0)),
    "an author entry was unnamed or not a string",
  );

  add(
    "publishedAt, when present, is ISO-8601",
    candidates.every((c) => c.publishedAt === undefined || !Number.isNaN(Date.parse(c.publishedAt))),
    "a candidate had an unparseable publishedAt",
  );

  /* ── the network it actually used ──────────────────────────────────────────── */

  const strayHosts = [...new Set(requested.map((u) => { try { return new URL(u).host; } catch { return u; } }))].filter(
    (h) => h !== originHost,
  );
  add(
    "ctx.fetch was used only for the verified origin",
    strayHosts.length === 0,
    `also requested ${JSON.stringify(strayHosts)} through the origin fetcher`,
  );

  const undeclared = [...new Set(offOriginRequested.map((u) => { try { return new URL(u).host; } catch { return u; } }))].filter(
    (h) => !offOrigin.includes(h),
  );
  add(
    "off-origin traffic stayed inside the declared allowlist",
    undeclared.length === 0,
    `reached undeclared hosts ${JSON.stringify(undeclared)}`,
  );

  return { adapterId: String(adapter.id), passed: checks.every((c) => c.ok), checks, requested };
}

/** Throw a readable aggregate when any check failed. The wrapper to call inside a test. */
export function assertConformance(report: ConformanceReport): void {
  if (report.passed) return;
  const failed = report.checks.filter((c) => !c.ok);
  const lines = failed.map((c) => `  ✗ ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`).join("\n");
  throw new Error(
    `adapter "${report.adapterId}" failed ${failed.length} of ${report.checks.length} conformance checks:\n${lines}\n` +
      `  requested: ${JSON.stringify(report.requested.slice(0, 10))}`,
  );
}
