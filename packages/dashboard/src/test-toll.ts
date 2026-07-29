/**
 * Test toll — the one question every install has: "is it actually tolling?"
 *
 * The console asks the gate for a tollable article while pretending to be a crawler,
 * and reports what came back. A `402` is the pass; anything else is diagnosed in
 * plain language, because "it returned 200" is useless without knowing that the most
 * common cause is a path outside ARTICLE_PATH_PREFIXES.
 *
 * Safety: the URL is built from GATE_URL and a slug the gate itself reported as
 * tollable — never from request input, so this is not an SSRF surface. Redirects are
 * NOT followed (`redirect: "manual"`), so a misconfigured origin cannot bounce the
 * probe at a host of its choosing. The probe is read-only: it never presents payment,
 * so it cannot settle or spend.
 */
import { getConfig } from "@naulon/shared";

/** A user-agent the gate's classifier reliably calls an agent, not a human. */
export const PROBE_UA = "GPTBot/1.0 (+naulon-dashboard-selftest)";

const TIMEOUT_MS = 8000;

export type ProbeStatus = "pass" | "fail" | "skipped";

export interface TollProbe {
  status: ProbeStatus;
  /** The URL probed, or null when we could not pick one. */
  url: string | null;
  slug: string | null;
  httpStatus: number | null;
  /** The gate's own explanation header, when present. */
  verdict: string | null;
  /** Whether the x402 PAYMENT-REQUIRED header came back. */
  quoted: boolean;
  /** One line: what happened. */
  summary: string;
  /** What to do about it — empty when it passed. */
  fix: string;
  elapsedMs: number;
}

export interface ProbeTarget {
  /** First tollable slug the gate reported, or null (API mode / no articles). */
  slug: string | null;
  /** True when credits come from a live API — we cannot enumerate a slug. */
  apiMode: boolean;
}

/**
 * Build the URL to probe: the gate, plus the first configured article prefix, plus a
 * slug known to be tollable. Exported for the test — the joining rules (no double
 * slash, prefix may or may not be given with one) are the fiddly part.
 */
export function probeUrl(gateUrl: string, prefixCsv: string, slug: string): string {
  const base = gateUrl.replace(/\/+$/, "");
  const prefix = (prefixCsv.split(",")[0] ?? "").trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${base}/${prefix}/${slug}` : `${base}/${slug}`;
}

/**
 * Turn an HTTP result into an operator-readable verdict. Split out from the fetch so
 * every branch is testable without a network.
 */
export function diagnose(httpStatus: number, quoted: boolean, verdict: string | null): {
  status: ProbeStatus;
  summary: string;
  fix: string;
} {
  if (httpStatus === 402) {
    return quoted
      ? { status: "pass", summary: "402 Payment Required, with a signed quote. The toll works.", fix: "" }
      : {
          status: "fail",
          summary: "402 came back without a PAYMENT-REQUIRED quote.",
          fix: "The gate refused but did not price the read. Check the article resolves in your credits source and that DEFAULT_PRICE_USDC is set.",
        };
  }
  if (httpStatus === 200) {
    return {
      status: "fail",
      summary: "200 OK — the gate served the article free to a crawler.",
      fix:
        "Three usual causes, in order: the path is not under ARTICLE_PATH_PREFIXES; " +
        "the slug is not in your credits source, so nothing is tollable; or a crawlerPolicy " +
        "is allow-listing this user-agent.",
    };
  }
  if (httpStatus === 404) {
    return {
      status: "fail",
      summary: "404 — your origin has no such article.",
      fix: "The slug came from your credits source but the origin does not serve it. Re-scan on the Content page, or fix the slug.",
    };
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      status: "fail",
      summary: `${httpStatus} redirect — the probe was bounced before it reached the toll.`,
      fix: "Usually a trailing-slash rule or an edge (Cloudflare, a CDN) in front of the gate. The gate must terminate the request, not something upstream of it.",
    };
  }
  if (httpStatus === 502 || httpStatus === 504) {
    return {
      status: "fail",
      summary: `${httpStatus} — the gate is up but cannot reach your origin.`,
      fix: "Check ORIGIN_URL and that your site is actually serving on it.",
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: "fail",
      summary: `${httpStatus} — something in front of the gate refused the request.`,
      fix: "A proxy, WAF, or basic-auth is intercepting before the toll. The gate has to see crawler traffic to charge for it.",
    };
  }
  return {
    status: "fail",
    summary: `${httpStatus} — not the 402 a tollable article should return.` + (verdict ? ` Gate verdict: ${verdict}.` : ""),
    fix: "Check the gate logs for this request.",
  };
}

/** Injectable so every failure branch is testable without depending on a port being
 *  closed — a test that only passes when no gate happens to be running is not a test. */
export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Run the probe. `target.slug` comes from the config summary the console already has. */
export async function runTollProbe(target: ProbeTarget, deps: ProbeDeps = {}): Promise<TollProbe> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const c = getConfig();
  const started = now();
  const base: Omit<TollProbe, "status" | "summary" | "fix"> = {
    url: null,
    slug: null,
    httpStatus: null,
    verdict: null,
    quoted: false,
    elapsedMs: 0,
  };

  if (!target.slug) {
    return {
      ...base,
      status: "skipped",
      summary: target.apiMode
        ? "Credits come from a live API, so the console cannot pick an article to test."
        : "No tollable article in your credits source yet.",
      fix: target.apiMode
        ? "Test it by hand: request one of your article URLs with a crawler user-agent and expect a 402."
        : "Add an article on the Content page, then run this again.",
      elapsedMs: now() - started,
    };
  }

  const url = probeUrl(c.GATE_URL, c.ARTICLE_PATH_PREFIXES, target.slug);
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { "user-agent": PROBE_UA, accept: "text/html" },
      redirect: "manual", // never let a misconfigured origin steer the probe
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const verdict = res.headers.get("x-naulon-verdict");
    const quoted = res.headers.has("payment-required");
    const d = diagnose(res.status, quoted, verdict);
    return {
      ...base,
      url,
      slug: target.slug,
      httpStatus: res.status,
      verdict,
      quoted,
      status: d.status,
      summary: d.summary,
      fix: d.fix,
      elapsedMs: now() - started,
    };
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    return {
      ...base,
      url,
      slug: target.slug,
      status: "fail",
      summary: timedOut ? "The gate did not answer in 8s." : "Could not reach the gate at all.",
      fix: timedOut
        ? "The gate is accepting connections but not responding — check whether it is blocked on your origin."
        : `Nothing is listening on ${c.GATE_URL}. Start the gate, or fix GATE_URL.`,
      elapsedMs: now() - started,
    };
  }
}
