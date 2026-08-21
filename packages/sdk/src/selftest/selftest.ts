/**
 * `naulon selftest` — drive YOUR OWN gate through one whole toll and report what happened.
 *
 * `doctor` answers "is this configured coherently, and does the gate challenge an agent?".
 * It stops at the 402. This goes the rest of the way: quote → pay → read the content → check
 * the licence that came back → prove the same payment cannot be replayed. That last stretch is
 * the part an operator actually wants proven before pointing real traffic at it, because a gate
 * that issues a 402 nobody can satisfy looks identical to a working one from outside.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never invents a path. The article URL is built from the prefix the gate advertises in
 *    its own `/.well-known/x402` manifest, and the slug comes from the operator's credits
 *    source. A publisher at `/writing/` is tested at `/writing/`.
 *  - It never moves real money. The payment below is the offline mock signature the gate
 *    accepts under `PAYMENT_MODE=mock` — the shape is `{payer, amount, nonce}`, base64. Against
 *    a gate in `gateway` mode that signature is refused by the facilitator, which is correct and
 *    is reported as such rather than dressed up as a failure of your setup.
 *
 * Pure, with fs + fetch injected, so the whole loop is unit-testable without a server —
 * same split as `runDoctor` / `runCheck`.
 */
import { z } from "zod";
import { parseCredits } from "../contract/credits.ts";
import { parseEnvFile } from "../doctor/doctor.ts";

export type Level = "pass" | "warn" | "fail";

export interface SelftestStep {
  name: string;
  level: Level;
  detail: string;
}

export interface SelftestInputs {
  /** `.env` contents, or null when there is none (the gate URL must then be given). */
  envText: string | null;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Absolute dir the `.env` lives in — resolves a relative CREDITS_FIXTURES. */
  cwd: string;
  fetchImpl: typeof fetch;
  /** Override where the gate is; defaults to http://localhost:${TOLLGATE_PORT}. */
  gateUrl?: string;
  /** Article to test. Defaults to the first slug in the credits source. */
  slug?: string;
  /** Skip the citation leg (the read leg alone still proves the loop). */
  skipCitation?: boolean;
}

export interface SelftestOutcome {
  steps: SelftestStep[];
  ok: boolean;
  /** Total atomic USDC the run authorized. Mock mode: nothing moved. */
  paidAtomic: bigint;
  /** The URL the run actually drove, so a failure names a thing you can curl. */
  url?: string;
}

const envSchema = z.object({
  PAYMENT_MODE: z.enum(["mock", "gateway"]).default("mock"),
  TOLLGATE_PORT: z.coerce.number().int().positive().default(8402),
  ARTICLE_PATH_PREFIXES: z.string().default("essays,articles,posts"),
  CREDITS_API_URL: z.string().url().optional(),
  CREDITS_FIXTURES: z.string().optional(),
});

/** The half of the x402 manifest this command reasons about. */
const manifestSchema = z.object({
  resources: z.object({ pathPrefixes: z.array(z.string()).min(1) }).partial().optional(),
  payment: z
    .object({ price: z.record(z.string(), z.object({ atomic: z.string() }).partial()).optional() })
    .partial()
    .optional(),
});

/** One `accepts` entry off a 402 — the only fields a payer needs. */
interface Quote {
  amount: string;
  payTo: string;
  nonce?: string;
}

/**
 * A payer address for the mock rail. Deterministic on purpose: a selftest that minted a fresh
 * address every run would scatter one-off payer rows through the operator's ledger, and the
 * whole point of the ledger is that a row means someone real read something.
 */
export const SELFTEST_PAYER = "0x5e1ff00000000000000000000000000000000001";

function joinPath(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return `${cwd.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
}

function decodeB64Json(v: string): unknown {
  return JSON.parse(Buffer.from(v, "base64").toString("utf8")) as unknown;
}

/** Pull the first payment requirement out of a 402's `payment-required` header. */
export function readQuote(header: string | null): Quote | undefined {
  if (!header) return undefined;
  let body: unknown;
  try {
    body = decodeB64Json(header);
  } catch {
    return undefined;
  }
  const accepts = (body as { accepts?: unknown[] } | null)?.accepts;
  const first = Array.isArray(accepts) ? accepts[0] : undefined;
  if (!first || typeof first !== "object") return undefined;
  const a = first as { amount?: unknown; payTo?: unknown; extra?: { nonce?: unknown } };
  if (typeof a.amount !== "string" || typeof a.payTo !== "string") return undefined;
  const nonce = a.extra && typeof a.extra.nonce === "string" ? a.extra.nonce : undefined;
  return { amount: a.amount, payTo: a.payTo, ...(nonce === undefined ? {} : { nonce }) };
}

/**
 * The offline signature `PAYMENT_MODE=mock` accepts, byte-identical to the gate's own
 * `buildMockSignature`. Duplicated rather than imported because that function lives in
 * `@naulon/tollgate`, which imports this package — importing it back would cycle. The
 * citation-leg test below is what catches the duplication drifting: a changed shape stops
 * settling and the step fails loudly rather than silently testing nothing.
 */
export function mockSignature(payer: string, amount: string, nonce?: string): string {
  return Buffer.from(JSON.stringify({ payer, amount, nonce })).toString("base64");
}

const AGENT_UA = "naulon-selftest/1 (+https://github.com/naulonapp/naulon)";
const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/**
 * How this run tells the gate it is a machine: `x-naulon-agent`, the declared-intent header,
 * which the classifier treats as its strongest signal (`agentDetect.classify`, step 1).
 *
 * The first version of this file sent only a bespoke user-agent and was read as a HUMAN — it
 * read free, and the quote step failed against a gate that was working perfectly. That is the
 * classifier behaving as designed (a UA it does not recognize is a reader, because mistaking a
 * human for a machine paywalls someone), and it is the reason a selftest must not lean on UA
 * sniffing. Impersonating `python-requests` would also have worked and would have been a lie
 * about what this program is.
 */
const AGENT_HEADERS = { "user-agent": AGENT_UA, "x-naulon-agent": "naulon-selftest" } as const;

export async function runSelftest(inp: SelftestInputs): Promise<SelftestOutcome> {
  const steps: SelftestStep[] = [];
  let paidAtomic = 0n;
  const done = (ok: boolean, url?: string): SelftestOutcome => ({
    steps,
    ok: ok && steps.every((s) => s.level !== "fail"),
    paidAtomic,
    ...(url === undefined ? {} : { url }),
  });

  // 1. Config — enough of it to find the gate and pick an article.
  const parsed = envSchema.safeParse(inp.envText === null ? {} : parseEnvFile(inp.envText));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    steps.push({
      name: "env",
      level: "fail",
      detail: `.env invalid: ${first ? `${first.path.join(".")} — ${first.message}` : "malformed"}`,
    });
    return done(false);
  }
  const cfg = parsed.data;
  const base = (inp.gateUrl ?? `http://localhost:${cfg.TOLLGATE_PORT}`).replace(/\/$/, "");

  // 2. The manifest. This is what makes the run publisher-agnostic: the path prefix under test
  //    is the one the gate publishes, not a constant compiled in here.
  let prefix = cfg.ARTICLE_PATH_PREFIXES.split(",")[0]?.trim() || "essays";
  let readAtomic: string | undefined;
  try {
    const res = await inp.fetchImpl(`${base}/.well-known/x402`, { headers: { accept: "application/json" } });
    if (!res.ok) {
      steps.push({ name: "manifest", level: "fail", detail: `${base}/.well-known/x402 → HTTP ${res.status}` });
      return done(false);
    }
    const m = manifestSchema.safeParse(await res.json());
    const advertised = m.success ? m.data.resources?.pathPrefixes?.[0] : undefined;
    if (advertised) prefix = advertised.replace(/^\/+|\/+$/g, "");
    readAtomic = m.success ? m.data.payment?.price?.["read"]?.atomic : undefined;
    steps.push({
      name: "manifest",
      level: "pass",
      detail: `self-describing toll at /${prefix}/${readAtomic ? ` · read ${readAtomic} atomic` : ""}`,
    });
  } catch (e) {
    steps.push({
      name: "manifest",
      level: "fail",
      detail: `gate not reachable at ${base} (${e instanceof Error ? e.message : String(e)}) — start it: \`make dev\``,
    });
    return done(false);
  }

  // 3. Which article. The operator's own credits source decides; API mode cannot be enumerated,
  //    so there it is an explicit --slug or nothing.
  let slug = inp.slug;
  if (!slug) {
    if (cfg.CREDITS_API_URL) {
      steps.push({
        name: "article",
        level: "fail",
        detail: "credits come from an API, which cannot be listed — name one with `--slug <slug>`",
      });
      return done(false);
    }
    const path = cfg.CREDITS_FIXTURES ? joinPath(inp.cwd, cfg.CREDITS_FIXTURES) : undefined;
    if (!path || !inp.fileExists(path)) {
      steps.push({ name: "article", level: "fail", detail: "no credits file to pick an article from — pass `--slug <slug>`" });
      return done(false);
    }
    try {
      const map = JSON.parse(inp.readFile(path)) as Record<string, unknown>;
      const first = Object.keys(map)[0];
      if (!first) {
        steps.push({ name: "article", level: "fail", detail: `${cfg.CREDITS_FIXTURES} has no articles yet — run \`naulon crawl\`` });
        return done(false);
      }
      parseCredits(map[first], `credits "${first}"`);
      slug = first;
    } catch (e) {
      steps.push({ name: "article", level: "fail", detail: `credits unreadable: ${e instanceof Error ? e.message : String(e)}` });
      return done(false);
    }
  }
  const url = `${base}/${prefix}/${encodeURIComponent(slug)}`;
  steps.push({ name: "article", level: "pass", detail: url });

  // 4. A human reads free. Checked FIRST and treated as fatal: every other property here is
  //    worth nothing if the gate is charging readers, and that is the one failure the project
  //    calls sacred.
  const human = await inp.fetchImpl(url, { headers: { "user-agent": HUMAN_UA, accept: "text/html" }, redirect: "manual" });
  if (human.status === 402) {
    steps.push({ name: "human", level: "fail", detail: "a browser UA was tolled — humans must read free" });
    return done(false, url);
  }
  steps.push({
    name: "human",
    level: human.ok ? "pass" : "warn",
    detail: human.ok
      ? `browser UA → HTTP ${human.status}, straight through`
      : `browser UA → HTTP ${human.status} (not tolled, but your origin did not serve it either)`,
  });

  // 5. A machine is billed.
  const challenge = await inp.fetchImpl(url, { headers: { ...AGENT_HEADERS }, redirect: "manual" });
  const quote = readQuote(challenge.headers.get("payment-required"));
  if (challenge.status !== 402 || !quote) {
    steps.push({
      name: "quote",
      level: "fail",
      detail: `agent UA → HTTP ${challenge.status}${quote ? "" : " with no payment-required header"} — expected a 402 challenge`,
    });
    return done(false, url);
  }
  steps.push({ name: "quote", level: "pass", detail: `402 · ${quote.amount} atomic → ${quote.payTo}` });

  // 6. Pay it and read the article.
  const sig = mockSignature(SELFTEST_PAYER, quote.amount, quote.nonce);
  const paid = await inp.fetchImpl(url, {
    headers: { ...AGENT_HEADERS, "payment-signature": sig },
    redirect: "manual",
  });
  if (!paid.ok) {
    const gateway = cfg.PAYMENT_MODE === "gateway";
    steps.push({
      name: "pay",
      level: gateway ? "warn" : "fail",
      detail: gateway
        ? `HTTP ${paid.status} — expected: this gate is in gateway mode, where a real facilitator refuses the offline mock signature. Prove the paid leg with the wayfarer against a funded wallet.`
        : `HTTP ${paid.status} — the gate refused a well-formed mock payment`,
    });
    return done(gateway, url);
  }
  paidAtomic += BigInt(quote.amount);
  steps.push({
    name: "pay",
    level: "pass",
    detail: `HTTP 200 · settled ${paid.headers.get("payment-response") ? "with a payment-response" : "(no payment-response header)"}`,
  });

  // 7. The licence. A paid read that hands back nothing verifiable is a receipt-less sale.
  const licence = paid.headers.get("x-naulon-license");
  if (!licence) {
    steps.push({ name: "licence", level: "warn", detail: "no x-naulon-license on the paid response" });
  } else {
    const body = licence.split(".")[1];
    let claim: { naulon?: { slug?: unknown; payees?: unknown } } | undefined;
    try {
      claim = body ? (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof claim) : undefined;
    } catch {
      claim = undefined;
    }
    const gotSlug = claim?.naulon?.slug;
    const payees = Array.isArray(claim?.naulon?.payees) ? claim.naulon.payees.length : 0;
    steps.push(
      gotSlug === slug && payees > 0
        ? { name: "licence", level: "pass", detail: `citation licence for "${gotSlug}" naming ${payees} payee(s)` }
        : { name: "licence", level: "warn", detail: `licence present but unreadable or for "${String(gotSlug)}"` },
    );
  }

  // 8. Replay. The same signature a second time must NOT buy a second read — the nonce is spent.
  //    This is the one step that fails closed on a security property rather than a feature.
  const replay = await inp.fetchImpl(url, {
    headers: { ...AGENT_HEADERS, "payment-signature": sig },
    redirect: "manual",
  });
  steps.push(
    replay.status === 402
      ? { name: "replay", level: "pass", detail: "the spent payment bought nothing a second time" }
      : { name: "replay", level: "fail", detail: `replaying the same payment returned HTTP ${replay.status} — the nonce was not consumed` },
  );

  // 9. A citation costs more than a read. Priced by CITATION_MULTIPLIER, so this asserts the
  //    relationship rather than a number.
  if (!inp.skipCitation) {
    const cite = await inp.fetchImpl(url, { headers: { ...AGENT_HEADERS, "x-naulon-kind": "citation" }, redirect: "manual" });
    const citeQuote = readQuote(cite.headers.get("payment-required"));
    if (cite.status !== 402 || !citeQuote) {
      steps.push({ name: "citation", level: "warn", detail: `citation kind → HTTP ${cite.status}, no quote` });
    } else if (BigInt(citeQuote.amount) <= BigInt(quote.amount)) {
      steps.push({
        name: "citation",
        level: "warn",
        detail: `a citation is priced at ${citeQuote.amount}, no more than a read at ${quote.amount}`,
      });
    } else {
      const citePaid = await inp.fetchImpl(url, {
        headers: {
          ...AGENT_HEADERS,
          "x-naulon-kind": "citation",
          "payment-signature": mockSignature(SELFTEST_PAYER, citeQuote.amount, citeQuote.nonce),
        },
        redirect: "manual",
      });
      if (citePaid.ok) paidAtomic += BigInt(citeQuote.amount);
      steps.push(
        citePaid.ok
          ? { name: "citation", level: "pass", detail: `${citeQuote.amount} atomic (${Number(BigInt(citeQuote.amount)) / Number(BigInt(quote.amount))}× a read) · paid, HTTP 200` }
          : { name: "citation", level: "warn", detail: `quoted ${citeQuote.amount} but the paid citation returned HTTP ${citePaid.status}` },
      );
    }
  }

  return done(true, url);
}
