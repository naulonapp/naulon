/**
 * `naulon doctor` — a health check for YOUR OWN gate.
 *
 * `naulon-kit check` validates a *remote* publisher's `/credits` endpoint. `doctor` is the
 * mirror for the operator: is *my* local setup coherent and would it toll correctly? It reads
 * the `.env`, validates it against the gate's own `configSchema`, confirms the credits source
 * resolves, sanity-checks the settlement mode, and — if the gate is running — probes it: a human
 * UA must read free, an agent UA must get a 402. All the logic is here (pure, with injected fs +
 * fetch) so it is unit-testable without a real filesystem or a running server, matching the
 * `runCheck` / `check` split.
 */
import { z } from "zod";
import { parseCredits } from "../contract/credits.ts";

/**
 * The subset of the gate's env that `doctor` reasons about. Deliberately NOT the gate's full
 * `configSchema` (in `@naulon/shared`, which imports this package — importing it back would
 * cycle). The gate itself fails loud on deeper config errors at boot; the live probe below
 * catches real misbehavior. This validates the handful of vars doctor's checks depend on.
 */
const doctorEnvSchema = z.object({
  PAYMENT_MODE: z.enum(["mock", "gateway"]).default("mock"),
  ORIGIN_URL: z.string().url().default("http://localhost:3000"),
  TOLLGATE_PORT: z.coerce.number().int().positive().default(8402),
  ARTICLE_PATH_PREFIXES: z.string().default("essays,articles,posts"),
  SETTLEMENT_NETWORK: z.enum(["arcTestnet", "baseSepolia", "base"]).default("arcTestnet"),
  CREDITS_API_URL: z.string().url().optional(),
  CREDITS_FIXTURES: z.string().optional(),
  RELAYER_PRIVATE_KEY: z.string().optional(),
  CIRCLE_API_KEY: z.string().optional(),
});

export type Level = "pass" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  level: Level;
  detail: string;
}

export interface DoctorInputs {
  /** `.env` file contents, or null if it's missing. */
  envText: string | null;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Absolute dir the `.env` lives in — resolves a relative CREDITS_FIXTURES. */
  cwd: string;
  /** Provide to run live gate probes; omit to skip them (e.g. in a pure unit test). */
  fetchImpl?: typeof fetch;
  /** Override where the gate is; defaults to http://localhost:${TOLLGATE_PORT}. */
  gateUrl?: string;
}

export interface DoctorOutcome {
  checks: DoctorCheck[];
  /** true when no check FAILED (warnings are allowed). */
  ok: boolean;
}

/** Parse a dotenv-style file into a flat record. Comments + blanks ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] && !line.trimStart().startsWith("#")) env[m[1]] = (m[2] ?? "").trim();
  }
  return env;
}

function joinPath(cwd: string, p: string): string {
  if (p.startsWith("/")) return p;
  return `${cwd.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
}

export async function runDoctor(inp: DoctorInputs): Promise<DoctorOutcome> {
  const checks: DoctorCheck[] = [];

  // 1. .env present + valid against the gate's OWN config schema.
  if (inp.envText === null) {
    checks.push({ name: "env", level: "fail", detail: "no .env found — run `naulon init`" });
    return { checks, ok: false };
  }
  const parsed = doctorEnvSchema.safeParse(parseEnvFile(inp.envText));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    checks.push({
      name: "env",
      level: "fail",
      detail: `.env invalid: ${first ? `${first.path.join(".")} — ${first.message}` : "malformed"}`,
    });
    return { checks, ok: false };
  }
  const cfg = parsed.data;
  checks.push({
    name: "env",
    level: "pass",
    detail: `valid — mode=${cfg.PAYMENT_MODE} origin=${cfg.ORIGIN_URL} port=${cfg.TOLLGATE_PORT}`,
  });

  // 2. Credits source resolves.
  let firstSlug: string | undefined;
  if (cfg.CREDITS_API_URL) {
    checks.push({
      name: "credits",
      level: "pass",
      detail: `API mode → ${cfg.CREDITS_API_URL} (conformance: \`naulon check ${cfg.CREDITS_API_URL} --slug <s>\`)`,
    });
  } else if (!cfg.CREDITS_FIXTURES) {
    checks.push({
      name: "credits",
      level: "warn",
      detail: "neither CREDITS_FIXTURES nor CREDITS_API_URL set — the gate falls back to its bundled default; run `naulon init`",
    });
  } else {
    const path = joinPath(inp.cwd, cfg.CREDITS_FIXTURES);
    if (!inp.fileExists(path)) {
      checks.push({ name: "credits", level: "fail", detail: `CREDITS_FIXTURES not found: ${cfg.CREDITS_FIXTURES}` });
    } else {
      try {
        const map = JSON.parse(inp.readFile(path)) as Record<string, unknown>;
        const slugs = Object.keys(map);
        for (const s of slugs) parseCredits(map[s], `credits "${s}"`);
        firstSlug = slugs[0];
        checks.push({
          name: "credits",
          level: slugs.length > 0 ? "pass" : "warn",
          detail: slugs.length > 0 ? `${slugs.length} valid entr${slugs.length === 1 ? "y" : "ies"}` : "file is empty — no articles to toll yet",
        });
      } catch (e) {
        checks.push({ name: "credits", level: "fail", detail: `CREDITS_FIXTURES invalid: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  // 3. Settlement-mode coherence.
  if (cfg.PAYMENT_MODE === "mock") {
    checks.push({ name: "settlement", level: "warn", detail: "mock — payments signed offline, no real USDC. Fine for dev." });
  } else {
    const hasRelayer = Boolean(cfg.RELAYER_PRIVATE_KEY);
    const hasCircle = Boolean(cfg.CIRCLE_API_KEY);
    const isArcMemo = cfg.SETTLEMENT_NETWORK === "arcTestnet"; // memo self-relay network
    if (isArcMemo && !hasRelayer) {
      checks.push({ name: "settlement", level: "warn", detail: `gateway on ${cfg.SETTLEMENT_NETWORK} but RELAYER_PRIVATE_KEY unset — real settle will error at settle-time` });
    } else if (!isArcMemo && !hasCircle) {
      checks.push({ name: "settlement", level: "warn", detail: `gateway on ${cfg.SETTLEMENT_NETWORK} but CIRCLE_API_KEY unset` });
    } else {
      checks.push({ name: "settlement", level: "pass", detail: `gateway on ${cfg.SETTLEMENT_NETWORK} — settlement creds present` });
    }
  }

  // 4. Live gate probes (only if a fetch impl was provided).
  if (inp.fetchImpl) {
    const base = (inp.gateUrl ?? `http://localhost:${cfg.TOLLGATE_PORT}`).replace(/\/$/, "");
    const prefix = cfg.ARTICLE_PATH_PREFIXES.split(",")[0]?.trim() || "essays";
    const slug = firstSlug ?? "example";
    const url = `${base}/${prefix}/${encodeURIComponent(slug)}`;
    try {
      const human = await inp.fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" }, redirect: "manual" });
      checks.push(
        human.status === 402
          ? { name: "gate:human", level: "fail", detail: `a human UA was tolled (402) on ${url} — humans must read free` }
          : { name: "gate:human", level: "pass", detail: `human UA → not tolled (HTTP ${human.status})` },
      );
      const agent = await inp.fetchImpl(url, { headers: { "user-agent": "python-requests/2.31" }, redirect: "manual" });
      const challenged = agent.status === 402 && (agent.headers.get("payment-required") !== null || agent.headers.get("link") !== null);
      checks.push(
        challenged
          ? { name: "gate:agent", level: "pass", detail: `agent UA → 402 + payment challenge on /${prefix}/${slug}` }
          : { name: "gate:agent", level: "warn", detail: `agent UA got HTTP ${agent.status} (expected 402) on /${prefix}/${slug} — check ARTICLE_PATH_PREFIXES + credits` },
      );
    } catch {
      checks.push({ name: "gate", level: "warn", detail: `gate not reachable at ${base} — start it: \`make dev\`` });
    }
  }

  return { checks, ok: checks.every((c) => c.level !== "fail") };
}
