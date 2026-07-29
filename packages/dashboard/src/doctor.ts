/**
 * Doctor — the preflight. Every check a self-hoster would otherwise run by hand
 * before asking "why isn't it earning", with the fix attached to each one.
 *
 * The console already had a `warnings` list, but it only spoke up when something was
 * wrong and it never said what to do. A check that PASSES is worth showing too: it is
 * how an operator convinces themselves the thing is configured, not just quiet.
 *
 * Read-only. Every check either reads config the gate already loaded or performs a
 * GET against an address from that config — nothing here writes, spends, or settles.
 */
import { access as fsAccess, constants as fsConstants } from "node:fs/promises";
import { dirname } from "node:path";
import { getConfig } from "@naulon/shared";
import { summarizeConfig, type ConfigSummary, type ConfigWarningCode } from "./config-view.ts";
import { isLoopback } from "./access.ts";
import { parseAllowedHosts } from "./host-guard.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  /**
   * What is being checked, phrased as the claim the operator WANTS to be true ("The
   * gate is up"). Because it is the positive phrasing, it must never be spliced into a
   * sentence about what went wrong — that is how the headline came to read "One thing
   * is stopping this gate from earning: credits are loaded." Use `detail` for that.
   */
  label: string;
  status: CheckStatus;
  /** What we actually found. On a fail this is the problem, in the operator's terms. */
  detail: string;
  /** What to do. Empty on a pass. */
  fix: string;
}

export interface DoctorReport {
  at: number;
  checks: Check[];
  counts: { pass: number; warn: number; fail: number };
  /** The single sentence to put at the top. */
  headline: string;
}

export interface GateHealth {
  up: boolean;
  detail?: string | undefined;
  startedAt?: string | undefined;
}

/** Inputs a caller must supply, so the checks stay pure and testable. */
export interface DoctorInput {
  config: ConfigSummary;
  health: GateHealth;
  /** Whether credits.json post-dates the gate's boot. */
  restartPending: boolean;
  /** Reachability of ORIGIN_URL, already probed. null = not probed. */
  originReachable: boolean | null;
  /** The access mode the server decided at boot. */
  accessMode: string;
  /** DASHBOARD_BIND, for the exposure check. */
  bind: string;
  /** Parsed DASHBOARD_ALLOWED_HOSTS — extra Host values the private console answers to. */
  allowedHosts: readonly string[];
  paymentMode: "mock" | "gateway";
  settlementNetwork: string;
  /**
   * Can the gate actually append to EVENTS_PATH? null = supabase backend (not a file).
   * A read-only volume or a wrong container uid loses every settlement event silently,
   * which is the failure this check exists to name.
   */
  eventsWritable: boolean | null;
}

const ok = (id: string, label: string, detail: string): Check => ({ id, label, status: "pass", detail, fix: "" });

/**
 * Build the checklist. Pure — every input is passed in, so each branch is testable
 * without a gate, an origin, or a filesystem.
 */
export function buildChecks(i: DoctorInput): Check[] {
  const checks: Check[] = [];

  // 1. Is the gate answering at all? Everything downstream is meaningless if not.
  checks.push(
    i.health.up
      ? ok("gate", "The gate is up", "It answered /healthz.")
      : {
          id: "gate",
          label: "The gate is up",
          status: "fail",
          detail: `No answer from the gate — ${i.health.detail ?? "unreachable"}.`,
          fix: "Start the gate, or fix GATE_URL. Nothing is being tolled while it is down.",
        },
  );

  // 2. Can the gate reach what it is fronting?
  if (i.originReachable === null) {
    checks.push({
      id: "origin",
      label: "Your origin answers",
      status: "warn",
      detail: "Not probed.",
      fix: "",
    });
  } else if (i.originReachable) {
    checks.push(ok("origin", "Your origin answers", `${i.config.originUrl} responded.`));
  } else {
    checks.push({
      id: "origin",
      label: "Your origin answers",
      status: "fail",
      detail: `${i.config.originUrl} did not respond.`,
      fix: "The gate proxies to this address. While it is down, every request 502s — humans included.",
    });
  }

  // 3. Is anything actually tollable? An empty credits source is a silent no-op — and
  //    an UNREADABLE one is a different problem with a different fix, so say which.
  //    Getting these two confused sent the operator to "scan your site" when the real
  //    answer was "the file isn't there".
  const unreadable = i.config.warnings.find((w) => w.code === "credits-unreadable");
  if (i.config.creditsSource.mode === "api") {
    checks.push(ok("credits", "Credits are loaded", `Served live from ${i.config.creditsSource.location}.`));
  } else if (unreadable) {
    checks.push({
      id: "credits",
      label: "Credits are loaded",
      status: "fail",
      detail: unreadable.message,
      fix: `The gate reads CREDITS_FIXTURES at boot. Create ${i.config.creditsSource.location} (valid JSON), or point CREDITS_FIXTURES / CREDITS_API_URL somewhere that exists.`,
    });
  } else if ((i.config.slugCount ?? 0) > 0) {
    checks.push(ok("credits", "Credits are loaded", `${i.config.slugCount} article(s) tollable, ${i.config.wallets.length} wallet(s).`));
  } else {
    checks.push({
      id: "credits",
      label: "Credits are loaded",
      status: "fail",
      detail: "No tollable articles.",
      fix: "Nothing can be charged for. Scan your site on the Content page and map at least one payout wallet.",
    });
  }

  // 4. Telemetry. Off is the single commonest reason the console looks dead.
  checks.push(
    i.config.observations === "off"
      ? {
          id: "observations",
          label: "Traffic is being recorded",
          status: "warn",
          detail: "OBSERVATIONS_BACKEND is off.",
          fix: "Set OBSERVATIONS_BACKEND=jsonl. The toll still works without it, but you cannot see who was served, denied, or paid.",
        }
      : ok("observations", "Traffic is being recorded", `OBSERVATIONS_BACKEND=${i.config.observations}.`),
  );

  // 5. The event log is what the ledger and earnings read. `EVENTS_BACKEND` only has
  //    two legal values, so reporting it was a row that could never do anything but
  //    pass — padding on a screen whose whole value is an honest count. What CAN go
  //    wrong is the file: a read-only volume or a container uid that can't write to
  //    EVENTS_PATH drops every settlement event with no error the operator ever sees.
  if (i.eventsWritable === false) {
    checks.push({
      id: "events",
      label: "Settlement events are being kept",
      status: "fail",
      detail: `EVENTS_BACKEND=jsonl, but ${i.config.eventsPath} is not writable.`,
      fix: "Every settled payment is being dropped, silently — the ledger will stay empty however much you earn. Fix the directory's permissions (or its volume mount) so the gate's user can append.",
    });
  } else if (i.eventsWritable === null) {
    checks.push(ok("events", "Settlement events are being kept", `EVENTS_BACKEND=supabase.`));
  } else {
    checks.push(ok("events", "Settlement events are being kept", `Appending to ${i.config.eventsPath}.`));
  }

  // 6. A zero price would quote nothing.
  checks.push(
    i.config.priceUsdc > 0
      ? ok("price", "A price is set", `$${i.config.priceUsdc.toFixed(6)} per read, ×${i.config.citationMultiplier} for a citation.`)
      : {
          id: "price",
          label: "A price is set",
          status: "fail",
          detail: "DEFAULT_PRICE_USDC is not a positive number.",
          fix: "Set DEFAULT_PRICE_USDC. A zero price means the gate has nothing to quote.",
        },
  );

  // 7. Mock settlement is correct for a trial and wrong for production — say which
  //    you are in rather than guessing what the operator intended.
  checks.push(
    i.paymentMode === "gateway"
      ? ok("payment", "Settlement is live", `PAYMENT_MODE=gateway on ${i.settlementNetwork}.`)
      : {
          id: "payment",
          label: "Settlement is live",
          status: "warn",
          detail: "PAYMENT_MODE=mock — payments are simulated.",
          fix: "Correct while you are trying it out. Nothing settles on-chain and no author is actually paid until you set PAYMENT_MODE=gateway.",
        },
  );

  // 8. Edits on disk that the running gate has not read.
  if (i.restartPending) {
    checks.push({
      id: "restart",
      label: "The gate is serving your current credits",
      status: "warn",
      detail: "credits.json changed after the gate started.",
      fix: "Restart the gate. Until you do, your edits are saved but not being enforced.",
    });
  } else {
    checks.push(ok("restart", "The gate is serving your current credits", "No pending edits."));
  }

  // 9. Exposure. The console shows wallets; how it is reachable is a real check.
  if (i.accessMode === "public") {
    checks.push(ok("exposure", "The console is not over-exposed", "Public earnings view — wallets masked, ops routes unmounted."));
  } else if (i.accessMode === "authed") {
    checks.push(ok("exposure", "The console is not over-exposed", "Bound wide, behind HTTP Basic."));
  } else if (isLoopback(i.bind)) {
    // Say what the Host allowlist ACTUALLY is. Claiming "loopback hostnames only" while
    // DASHBOARD_ALLOWED_HOSTS names three more is a lie on the one screen whose entire
    // job is to report posture — and it leaves the operator nothing to read when a
    // typo'd entry starts 403ing their proxy.
    checks.push(
      ok(
        "exposure",
        "The console is not over-exposed",
        i.allowedHosts.length
          ? `Loopback only (${i.bind}); it answers to loopback hostnames plus ${i.allowedHosts.join(", ")}.`
          : `Loopback only (${i.bind}), and it answers only to loopback hostnames.`,
      ),
    );
  } else {
    checks.push({
      id: "exposure",
      label: "The console is not over-exposed",
      status: "fail",
      detail: `Bound to ${i.bind} without auth.`,
      fix: "Set DASHBOARD_AUTH, or bind 127.0.0.1. This view shows payout wallets.",
    });
  }

  // 10. Anything config-view flagged that no check above already reports. Keyed on the
  //     warning CODE, never the message text: the old prose match let "the fixture has
  //     no articles" through, so an empty fixture rendered twice — a `fail` from check 3
  //     and a `warn` here, labelled "Credits parse cleanly" when nothing had failed to
  //     parse, and counted as two problems instead of one.
  const COVERED: ReadonlySet<ConfigWarningCode> = new Set<ConfigWarningCode>([
    "observations-off", // check 4
    "credits-api-dynamic", // check 3, api branch — informational, not a warning
    "credits-empty", // check 3, fail branch
    "credits-unreadable", // check 3, fail branch
  ]);
  for (const [n, w] of i.config.warnings.entries()) {
    if (COVERED.has(w.code)) continue;
    checks.push({
      id: `config-warning-${n}`,
      label: "Credits parse cleanly",
      status: "warn",
      detail: w.message,
      fix: "Fix the entry in your credits source — a malformed one is skipped, so that article earns nothing.",
    });
  }

  return checks;
}

/**
 * One sentence for the top of the page — the worst thing found, or the all-clear.
 *
 * The single-failure line names the check's `detail` (the problem), NOT its `label`.
 * The label is phrased as the claim the operator wants to be true, so splicing it in
 * produced the exact inverse of the truth: a missing credits file rendered as "One
 * thing is stopping this gate from earning: credits are loaded." `detail` is already a
 * standalone sentence, so it is appended as one rather than lowercased into the clause
 * — which also keeps `DEFAULT_PRICE_USDC` and URLs from being case-mangled.
 */
export function headlineFor(checks: readonly Check[]): string {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  if (fails.length) {
    return fails.length === 1
      ? `One thing is stopping this gate from earning. ${fails[0]!.detail}`
      : `${fails.length} things are stopping this gate from earning.`;
  }
  if (warns.length) {
    return warns.length === 1
      ? "Everything essential is working. One thing is worth a look."
      : `Everything essential is working. ${warns.length} things are worth a look.`;
  }
  return "Everything checks out. The gate is configured to toll.";
}

/** Probe the origin with a HEAD, falling back to GET. Address comes from config only. */
async function probeOrigin(originUrl: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const r = await fetch(originUrl, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      // Any answer at all proves something is listening — even a 404 or a redirect.
      if (r.status > 0) return true;
    } catch {
      // try the next method, then give up
    }
  }
  return false;
}

/**
 * Can the gate append to the events log? Probes the DIRECTORY, not the file: the file
 * legitimately does not exist until the first settlement, and `W_OK` on a missing path
 * always fails. Only meaningful for the jsonl backend — supabase gets null.
 */
async function probeEventsWritable(backend: string, eventsPath: string): Promise<boolean | null> {
  if (backend !== "jsonl") return null;
  try {
    await fsAccess(dirname(eventsPath), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run the full report. `health` is passed in because the server already computes it. */
export async function runDoctor(input: {
  health: GateHealth;
  restartPending: boolean;
  accessMode: string;
  now?: number;
}): Promise<DoctorReport> {
  const c = getConfig();
  const config = await summarizeConfig();
  const [originReachable, eventsWritable] = await Promise.all([
    probeOrigin(config.originUrl),
    probeEventsWritable(config.events, config.eventsPath),
  ]);
  const checks = buildChecks({
    config,
    health: input.health,
    restartPending: input.restartPending,
    originReachable,
    accessMode: input.accessMode,
    bind: c.DASHBOARD_BIND,
    allowedHosts: parseAllowedHosts(c.DASHBOARD_ALLOWED_HOSTS),
    paymentMode: c.PAYMENT_MODE,
    settlementNetwork: c.SETTLEMENT_NETWORK,
    eventsWritable,
  });
  return {
    at: input.now ?? Date.now(),
    checks,
    counts: {
      pass: checks.filter((x) => x.status === "pass").length,
      warn: checks.filter((x) => x.status === "warn").length,
      fail: checks.filter((x) => x.status === "fail").length,
    },
    headline: headlineFor(checks),
  };
}
