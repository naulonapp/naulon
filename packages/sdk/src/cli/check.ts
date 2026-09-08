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
 * A webhook is never POSTed to a live receiver (a money-adjacent path gets no public
 * "pretend" mode). With --secret the CLI prints a signed `settlement.completed`
 * delivery you feed into YOUR receiver in YOUR test harness and assert a 200 + a
 * written row.
 */
import { parseCredits, type ArticleCredits, type Contributor } from "../contract/credits.ts";
import { makeSignedWebhookFixture } from "../crypto/fixture.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * An `ok: false` that must not fail the run. Reserved for something true and worth saying that
   * is nevertheless a legal way to publish — a lower-case payee address is the only one today.
   * Kept out of `allPassed` so a publisher wiring up CI is never forced to choose between a red
   * pipeline and turning the check off.
   */
  level?: "advisory";
}

export interface RunCheckOutcome {
  checks: CheckResult[];
  fixture?: ReturnType<typeof makeSignedWebhookFixture>;
  allPassed: boolean;
}

/** Every leaf wallet in the credits graph, composites included. */
function collectPayees(contributors: Contributor[]): string[] {
  const out: string[] = [];
  for (const c of contributors) {
    if (c.members && c.members.length > 0) out.push(...collectPayees(c.members));
    else if (c.wallet) out.push(c.wallet);
  }
  return out;
}

/** `0x1234…cdef` — enough to identify which address is meant without wrapping the terminal. */
function shortAddr(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
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
  /** Set only when the endpoint answered with a contract-valid body — check 1b needs the payees. */
  let credits: ArticleCredits | undefined;

  // 1. The credits endpoint returns a contract-valid body.
  try {
    const res = await fetchImpl(creditsUrl(opts.slug), { headers: auth });
    if (res.status !== 200) {
      checks.push({ name: "credits-endpoint", ok: false, detail: `expected 200 for "${opts.slug}", got ${res.status}` });
    } else {
      const body = await res.json();
      credits = parseCredits(body, `credits for "${opts.slug}"`); // throws on any contract violation
      checks.push({ name: "credits-endpoint", ok: true, detail: `200 + valid ArticleCredits for "${opts.slug}"` });
    }
  } catch (e) {
    checks.push({ name: "credits-endpoint", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 1b. Wallet hygiene on whatever that body named as a payee.
  //
  // Not a second parse of the same rules: the contract already refused a malformed address and
  // the burn address before this line could run. What it cannot judge is an address that is
  // well-formed, spendable by SOMEONE, and not the one the publisher meant. EIP-55 is the defence
  // against that, and it only works on a mixed-case address — an all-lower or all-upper address
  // carries no checksum at all, so a transposed character in it is undetectable by anyone, at any
  // layer, ever. That is worth saying out loud beside a money destination, and it is not a
  // failure: lower-case is a legal way to write an address and plenty of tooling emits it.
  //
  // Verifying a mixed-case checksum needs keccak256, which would mean a hashing dependency in a
  // publisher-installed SDK that has two. The portal does that check at the point of entry, where
  // viem is already present; here we report what can be known for free.
  if (credits) {
    const payees = collectPayees(credits.contributors);
    const uncheckable = payees.filter((w) => w === w.toLowerCase() || w === w.toUpperCase());
    checks.push(
      uncheckable.length === 0
        ? {
            name: "wallet-checksum",
            ok: true,
            detail: `all ${payees.length} payee address(es) carry an EIP-55 checksum`,
          }
        : {
            name: "wallet-checksum",
            ok: false,
            level: "advisory",
            detail:
              `${uncheckable.length} of ${payees.length} payee address(es) carry no checksum ` +
              `(${uncheckable.map(shortAddr).join(", ")}). A typo in these cannot be detected by ` +
              `anything — paste the mixed-case form your wallet displays instead.`,
          },
    );
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

  const outcome: RunCheckOutcome = {
    checks,
    allPassed: checks.every((c) => c.ok || c.level === "advisory"),
  };
  if (opts.secret) outcome.fixture = makeSignedWebhookFixture({ secret: opts.secret });
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
  for (const c of out.checks) {
    const tag = c.ok ? "PASS" : c.level === "advisory" ? "NOTE" : "FAIL";
    console.log(`${tag}  ${c.name}  —  ${c.detail}`);
  }
  if (out.fixture) {
    console.log("\nSigned webhook fixture (POST to YOUR receiver in YOUR test harness — never production):");
    console.log(`  naulon-signature: ${out.fixture.headers["naulon-signature"]}`);
    console.log(`  body: ${out.fixture.rawBody}`);
  }
  console.log(out.allPassed ? "\n✓ all checks passed" : "\n✗ one or more checks failed");
  return out.allPassed ? 0 : 1;
}

// Run only when invoked directly as the bin, not when imported (by a test or the dispatcher).
if (process.argv[1] && /check\.(ts|js)$/.test(process.argv[1])) {
  void checkMain(process.argv.slice(2)).then((c) => process.exit(c));
}
