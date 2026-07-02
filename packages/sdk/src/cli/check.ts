#!/usr/bin/env node
/**
 * `naulon-kit check` — offline conformance for a publisher's credits endpoint.
 *
 *   npx @naulon/sdk check <baseUrl> --slug <s> [--token <t>] [--secret <sec>]
 *
 * It does two things a publisher gets wrong and can verify cheaply:
 *   1. GET <baseUrl>/credits/<slug> parses against the shared contract (creditsSchema).
 *   2. GET <baseUrl>/credits/<random> returns 404 — the deliberate "free read" signal.
 *      (This checks the 404 *syntax*, never *policy*: the CLI can't know which slug
 *      SHOULD be free.)
 * Settlement is never POSTed to a live receiver (a money path gets no public "pretend"
 * mode). With --secret the CLI prints a signed fixture you feed into YOUR receiver in
 * YOUR test harness and assert a 200 + a written payout.
 */
import { parseCredits } from "../contract/credits.ts";
import { makeSignedSettlementFixture } from "../crypto/fixture.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunCheckOutcome {
  checks: CheckResult[];
  fixture?: ReturnType<typeof makeSignedSettlementFixture>;
  allPassed: boolean;
}

export async function runCheck(opts: {
  baseUrl: string;
  slug: string;
  /** A slug expected NOT to exist — defaults injected by the CLI; explicit in tests. */
  absentSlug: string;
  token?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
}): Promise<RunCheckOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const creditsUrl = (slug: string) => `${base}/credits/${encodeURIComponent(slug)}`;
  const checks: CheckResult[] = [];

  // 1. The credits endpoint returns a contract-valid body.
  try {
    const res = await fetchImpl(creditsUrl(opts.slug), { headers: auth });
    if (res.status !== 200) {
      checks.push({ name: "credits-endpoint", ok: false, detail: `expected 200 for "${opts.slug}", got ${res.status}` });
    } else {
      const body = await res.json();
      parseCredits(body, `credits for "${opts.slug}"`); // throws on any contract violation
      checks.push({ name: "credits-endpoint", ok: true, detail: `200 + valid ArticleCredits for "${opts.slug}"` });
    }
  } catch (e) {
    checks.push({ name: "credits-endpoint", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 2. A nonexistent slug answers 404 — the free-read signal (syntax, not policy).
  try {
    const res = await fetchImpl(creditsUrl(opts.absentSlug), { headers: auth });
    checks.push(
      res.status === 404
        ? { name: "free-signal-404", ok: true, detail: "nonexistent slug → 404 (free-read signal; syntax only, not policy)" }
        : { name: "free-signal-404", ok: false, detail: `nonexistent slug should answer 404, got ${res.status}` },
    );
  } catch (e) {
    checks.push({ name: "free-signal-404", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  const outcome: RunCheckOutcome = { checks, allPassed: checks.every((c) => c.ok) };
  if (opts.secret) outcome.fixture = makeSignedSettlementFixture({ secret: opts.secret });
  return outcome;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { baseUrl?: string; slug?: string; token?: string; secret?: string } {
  const out: { baseUrl?: string; slug?: string; token?: string; secret?: string } = {};
  const rest = argv[0] === "check" ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--slug") out.slug = rest[++i];
    else if (a === "--token") out.token = rest[++i];
    else if (a === "--secret") out.secret = rest[++i];
    else if (a && !a.startsWith("--") && out.baseUrl === undefined) out.baseUrl = a;
  }
  return out;
}

const USAGE = "usage: naulon-kit check <baseUrl> --slug <slug> [--token <t>] [--secret <sec>]";

export async function checkMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.baseUrl || !args.slug) {
    console.error(USAGE);
    return 2;
  }
  const out = await runCheck({
    baseUrl: args.baseUrl,
    slug: args.slug,
    absentSlug: `__naulon-kit-absent-${Date.now()}__`,
    token: args.token,
    secret: args.secret,
  });
  for (const c of out.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  —  ${c.detail}`);
  if (out.fixture) {
    console.log("\nSigned settlement fixture (POST to YOUR receiver in YOUR test harness — never production):");
    console.log(`  x-naulon-timestamp: ${out.fixture.headers["x-naulon-timestamp"]}`);
    console.log(`  x-naulon-signature: ${out.fixture.headers["x-naulon-signature"]}`);
    console.log(`  body: ${out.fixture.rawBody}`);
  }
  console.log(out.allPassed ? "\n✓ all checks passed" : "\n✗ one or more checks failed");
  return out.allPassed ? 0 : 1;
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /check\.(ts|js)$/.test(process.argv[1])) {
  void checkMain(process.argv.slice(2)).then((c) => process.exit(c));
}
