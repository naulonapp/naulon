/**
 * Dashboard server — the self-host operator's window onto the gate.
 *
 *   /              ops console (private) · or the public earnings page (public mode)
 *   /ledger        the public earnings page (operator preview)
 *   /api/ops       health + traffic verdicts + config sanity   (never public)
 *   /api/ledger    settled-earnings aggregate                  (wallets masked in public)
 *   /api/stream    SSE earnings snapshots
 *   /*.css /*.js   the view assets (same-origin → strict CSP holds)
 *
 * Access is decided ONCE at boot (see access.ts): loopback-only reach → private ops;
 * reachable + DASHBOARD_AUTH → ops behind Basic; DASHBOARD_PUBLIC → earnings-only,
 * masked; reachable + neither → refuse (don't leak wallets). "Reachable" counts a
 * non-loopback DASHBOARD_ALLOWED_HOSTS entry, not just a wide bind — a serverless
 * deploy never binds at all, and used to read as private while facing the internet.
 * That decision drives everything.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getConfig, getSink } from "@naulon/shared";
import { aggregate, type Ledger } from "./aggregate.ts";
import { watchLedger } from "./watch.ts";
import { summarizeOps, windowMsFromKey } from "./ops.ts";
import { watchOps } from "./watch-ops.ts";
import { buildAgents, buildTraffic, parseVerdict } from "./traffic.ts";
import {
  exportFilename,
  parseFormat,
  parseKind,
  serializeEvents,
  serializeObservations,
} from "./export.ts";
import { summarizeConfig } from "./config-view.ts";
import { readObservations } from "./observations.ts";
import { readContent, scanArticles, writeCredits, isRestartPending } from "./content.ts";
import { readCrawlers, writeCrawlers, isPolicyRestartPending } from "./crawlers.ts";
import { runDoctor } from "./doctor.ts";
import { buildWebhooksView, queuePing, resendDelivery } from "./webhooks.ts";
import { runTollProbe } from "./test-toll.ts";
import { decideAccess } from "./access.ts";
import { CSP, shouldNotStore } from "./security-headers.ts";
import { createCredentialVerifier, parseDashboardAuth } from "./credential.ts";
import { auditPathFor, createAuditor } from "./console-audit.ts";
import { audited, consoleAuth, mountConsoleAuth, getPrincipal, requireRole, type ConsoleAuthDeps } from "./console-auth.ts";
import { createFileStore, defaultStatePath } from "./console-store.ts";
import { createUser, hasAnyUser } from "./console-users.ts";
import { checkOrigin } from "./same-origin.ts";
import { authThrottle } from "./authThrottle.ts";
import { isAllowedHost, parseAllowedHosts, isLoopbackHostname } from "./host-guard.ts";
import { tileSvg } from "./brand.ts";
import { RECENT_LIMIT } from "./constants.ts";

const cfg = getConfig();
const sink = getSink();
const PUBLIC = new URL("./public/", import.meta.url);

// Parsed before the access decision because it is an INPUT to it: a non-loopback name
// here means strangers can address this console, which a loopback bind would otherwise
// hide (serverless, or a reverse proxy). See access.ts.
const ALLOWED_HOSTS = parseAllowedHosts(cfg.DASHBOARD_ALLOWED_HOSTS);

/**
 * The credential, parsed once. Null when DASHBOARD_AUTH is absent OR malformed — and
 * those two are NOT the same thing downstream: absent is a mode (private/public/refuse),
 * malformed is an operator who asked for a credential and would otherwise get none.
 */
const CREDENTIAL = parseDashboardAuth(cfg.DASHBOARD_AUTH);

const VERIFY = CREDENTIAL ? createCredentialVerifier(CREDENTIAL) : null;

/**
 * Console identity state. Absent in PUBLIC mode, which serves one masked page and has no
 * notion of an operator — building a user store for it would be inventing a login for a
 * page whose entire purpose is being readable without one.
 */
const STATE_PATH = cfg.CONSOLE_STATE_PATH ?? defaultStatePath(cfg.EVENTS_PATH);
const STORE = cfg.DASHBOARD_PUBLIC ? null : await createFileStore(STATE_PATH);

/**
 * The container path to a first administrator: seed once, force a change on first use.
 * Grafana's `admin_password` shape, and the same caveat — a seeded password sits in the
 * environment, so it is a bootstrap value, never a credential to keep.
 */
export const seededAdmin =
  STORE && cfg.CONSOLE_ADMIN_PASSWORD && !(await hasAnyUser(STORE))
    ? await createUser(STORE, {
        username: cfg.CONSOLE_ADMIN_USERNAME,
        password: cfg.CONSOLE_ADMIN_PASSWORD,
        role: "admin",
        mustChangePassword: true,
      })
    : null;

const HAS_USERS = STORE ? await hasAnyUser(STORE) : false;

let AUTH_DEPS: ConsoleAuthDeps | null = null;

const ACCESS = decideAccess({
  hasUsers: HAS_USERS,
  bind: cfg.DASHBOARD_BIND,
  auth: cfg.DASHBOARD_AUTH,
  isPublic: cfg.DASHBOARD_PUBLIC,
  allowedHosts: ALLOWED_HOSTS,
});

const isPublic = ACCESS.mode === "public";

// The page served at "/" depends on the mode: the ops console by default, the
// stripped public earnings page when DASHBOARD_PUBLIC.
const ASSETS: Record<string, { file: string; type: string }> = isPublic
  ? {
      "/": { file: "ledger.html", type: "text/html; charset=utf-8" },
      "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
      "/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
      "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
    }
  : {
      "/": { file: "overview.html", type: "text/html; charset=utf-8" },
      "/requests": { file: "requests.html", type: "text/html; charset=utf-8" },
      "/agents": { file: "agents.html", type: "text/html; charset=utf-8" },
      "/ledger": { file: "ledger.html", type: "text/html; charset=utf-8" },
      "/content": { file: "content.html", type: "text/html; charset=utf-8" },
      "/crawlers": { file: "crawlers.html", type: "text/html; charset=utf-8" },
      "/webhooks": { file: "webhooks.html", type: "text/html; charset=utf-8" },
      "/doctor": { file: "doctor.html", type: "text/html; charset=utf-8" },
      "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
      "/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
      "/overview.js": { file: "overview.js", type: "text/javascript; charset=utf-8" },
      "/requests.js": { file: "requests.js", type: "text/javascript; charset=utf-8" },
      "/agents.js": { file: "agents.js", type: "text/javascript; charset=utf-8" },
      "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
      "/content.js": { file: "content.js", type: "text/javascript; charset=utf-8" },
      "/crawlers.js": { file: "crawlers.js", type: "text/javascript; charset=utf-8" },
      "/webhooks.js": { file: "webhooks.js", type: "text/javascript; charset=utf-8" },
      "/doctor.js": { file: "doctor.js", type: "text/javascript; charset=utf-8" },
    };

const maskWallet = (w: string): string => (w.length > 12 ? w.slice(0, 6) + "…" + w.slice(-4) : w);
const maskLedger = (l: Ledger): Ledger => ({
  ...l,
  authors: l.authors.map((a) => ({ ...a, wallet: maskWallet(a.wallet) })),
  recent: l.recent.map((c) => ({ ...c, payer: maskWallet(c.payer) })),
});
const ledgerFor = (l: Ledger): Ledger => (isPublic ? maskLedger(l) : l);

async function gateHealth(): Promise<{ up: boolean; service?: string; startedAt?: string; detail?: string }> {
  const url = cfg.GATE_URL.replace(/\/$/, "") + "/healthz";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false, detail: `HTTP ${r.status}` };
    const j = (await r.json()) as { ok?: boolean; service?: string; startedAt?: string };
    return { up: j.ok === true, service: j.service, startedAt: j.startedAt };
  } catch (e) {
    // A throw here always means we couldn't reach the gate — surface that plainly
    // rather than Node's opaque "fetch failed".
    return { up: false, detail: (e as Error).name === "TimeoutError" ? "timed out" : "unreachable" };
  }
}

export const app = new Hono();

// Security headers on EVERY response — registered before the Host guard so it also
// wraps the guard's own 403. It didn't, and that response (the one an attacker can
// force, echoing their Host back) was the single response in the app served with no
// CSP, no nosniff and no Referrer-Policy. Order matters here: a middleware that
// returns without calling next() skips everything registered after it.
app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  // No caching of HTML. Every page this console serves is authenticated once accounts
  // exist, and without this the browser re-renders /account from history after a sign-out
  // — operator roster, username and role, on a shared machine, from a session that has
  // been destroyed server-side. Measured 2026-08-21: /account carried no Cache-Control at
  // all. Static assets keep their caching; they are matched by content type, not by path,
  // so a new HTML route cannot forget to opt in.
  if (shouldNotStore(c.res.headers.get("Content-Type"))) c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  // `same-origin`, not `no-referrer`. Both send nothing to a third party — the property
  // that matters for an ops console — but `no-referrer` ALSO makes Chrome send `Origin:
  // null` on the console's own form posts, which is what broke the sign-in page. Keeping a
  // header whose only remaining effect is to blind our own CSRF check is not hardening.
  c.header("Referrer-Policy", "same-origin");
});

// DNS-rebinding guard — before anything reads or renders. Private mode runs without
// auth, so the Host allowlist is the only thing that stops a page the operator visits
// from re-pointing its own hostname at 127.0.0.1 and reading the ops API same-origin.
// See host-guard.ts for the full shape. ALLOWED_HOSTS is parsed above, next to the
// access decision it feeds.
app.use("*", async (c, next) => {
  if (!isAllowedHost(c.req.header("Host"), ALLOWED_HOSTS, ACCESS.mode)) {
    // The Host is echoed so the operator can see WHICH value was refused (a proxy
    // sending an unexpected name is the whole failure mode). It is attacker-controlled,
    // so it stays in a text/plain body under the nosniff + CSP set above — never
    // interpolated into HTML.
    //
    // The remedy has to be stated in FULL. Naming the host alone used to be enough,
    // which quietly turned an unauthenticated console into a public one; now it is
    // refused at boot, so telling the operator only half the fix would walk them from
    // this 403 straight into a 503.
    return c.text(
      `naulon dashboard: refusing a request for Host "${c.req.header("Host") ?? "(absent)"}".\n\n` +
        `The private console has no authentication, so it answers only to loopback\n` +
        `hostnames.\n\n` +
        `Reaching it through a reverse proxy or a hosted platform is a real exposure,\n` +
        `so it takes BOTH:\n\n` +
        `  DASHBOARD_ALLOWED_HOSTS=<the hostname you use>   # name it (comma-separated)\n` +
        `  DASHBOARD_AUTH=user:pass                         # and put a credential on it\n\n` +
        `Or DASHBOARD_PUBLIC=true to serve only the masked earnings page.\n`,
      403,
    );
  }
  await next();
});

// Fail safe: bound wide with no auth, or an unreadable credential, and not public →
// serve nothing but the reason (access.ts decides both).
if (ACCESS.refuse) {
  app.all("*", (c) => c.text(`naulon dashboard refused to start serving.\n\n${ACCESS.reason}\n`, 503));
} else {
  if (STORE) {
    // Order is load-bearing, twice over. hono composes middleware in REGISTRATION order,
    // so the failed-sign-in budget has to be mounted before the gate whose 401s it charges,
    // and the gate before every route it protects.
    const AUDITOR = createAuditor(STORE.writable ? auditPathFor(STATE_PATH) : null);
    AUTH_DEPS = {
      store: STORE,
      auditor: AUDITOR,
      lifetimes: {
        idleMs: cfg.CONSOLE_SESSION_IDLE_MINUTES * 60_000,
        absoluteMs: cfg.CONSOLE_SESSION_ABSOLUTE_HOURS * 3_600_000,
      },
      // The machine credential, narrowed: it exists only if DASHBOARD_AUTH parsed, and it
      // carries DASHBOARD_AUTH_ROLE — viewer unless the operator says otherwise.
      machine:
        CREDENTIAL && VERIFY
          ? { username: CREDENTIAL.username, verify: VERIFY, role: cfg.DASHBOARD_AUTH_ROLE }
          : null,
      loopbackOnly: isLoopbackHostname(cfg.DASHBOARD_BIND) && ALLOWED_HOSTS.every(isLoopbackHostname),
      privateMode: ACCESS.mode === "private",
    };
    app.use("*", authThrottle());
    app.use("*", consoleAuth(AUTH_DEPS));
    mountConsoleAuth(app, AUTH_DEPS);
  }

  for (const [path, asset] of Object.entries(ASSETS)) {
    app.get(path, async (c) => {
      c.header("Content-Type", asset.type);
      return c.body(await readFile(new URL(asset.file, PUBLIC), "utf8"));
    });
  }

  // Fonts — same-origin so the strict CSP holds. Explicit allowlist, never a path
  // join from user input.
  const FONTS = new Set([
    "fraunces-latin.woff2",
    "hanken-grotesk-latin.woff2",
    "jetbrains-mono-latin.woff2",
  ]);
  app.get("/fonts/:file", async (c) => {
    const file = c.req.param("file");
    if (!FONTS.has(file)) return c.notFound();
    c.header("Content-Type", "font/woff2");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(await readFile(new URL(`fonts/${file}`, PUBLIC)));
  });

  app.get("/favicon.svg", (c) => {
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(tileSvg(32));
  });

  app.get("/api/ledger", async (c) => c.json(ledgerFor(aggregate(await sink.readAll(), RECENT_LIMIT))));

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const signal = { aborted: false };
      stream.onAbort(() => {
        signal.aborted = true;
      });
      for await (const led of watchLedger(sink, { signal })) {
        if (stream.aborted) break;
        await stream.writeSSE({ event: "ledger", data: JSON.stringify(ledgerFor(led)) });
      }
    }),
  );

  // Ops + content planes — never exposed publicly (wallets, config, the write path).
  if (!isPublic) {
    // State-changing routes: reject cross-origin (Basic-auth browsers auto-send
    // creds, so a same-origin check is the CSRF guard on this money-write surface).
    // Prefer Origin; fall back to Referer's host when Origin is absent (older
    // browsers / some form posts omit Origin but still send Referer). Neither
    // present ⇒ not a browser CSRF vector (curl/tooling carry no ambient creds).
    // The rule moved to same-origin.ts, and it now depends on WHICH credential
    // authenticated: a session cookie is ambient, so an unattributed write is refused
    // outright; the machine credential is not, so the old lenient path still holds for it.
    const sameOrigin = async (c: import("hono").Context, next: () => Promise<void>) => {
      const verdict = checkOrigin(c, getPrincipal(c)?.kind === "session" ? "strict" : "lenient");
      if (!verdict.ok) return c.text(verdict.refusal ?? "refused", 403);
      await next();
    };

    /** The six ops writes are administrator-only once the console has accounts. */
    const adminOnly = requireRole("admin");

    /**
     * ...and each one is recorded against whoever ran it. "Who ran that test toll" was the
     * whole argument for accounts over a shared password, and until this line the audit log
     * held sign-ins and account changes only — every question answered except that one.
     *
     * Mounted OUTERMOST, before the CSRF and role guards. A guard that refuses returns
     * without calling next(), so an audit behind one records nothing — and a refused write
     * is precisely the entry an operator goes looking for. Caught by its own test.
     */
    const auditWrite = (action: string): import("hono").MiddlewareHandler =>
      AUTH_DEPS ? audited(action, AUTH_DEPS.auditor) : async (_c, next) => { await next(); };

    app.get("/api/ops", async (c) => {
      const now = Date.now();
      const windowMs = windowMsFromKey(c.req.query("window"));
      const [health, observations, config] = await Promise.all([
        gateHealth(),
        readObservations(),
        summarizeConfig(),
      ]);
      return c.json({ at: now, health, ops: summarizeOps(observations, now, windowMs), config });
    });

    // The traffic tail. Everything the Overview's six counters summarise, unrolled:
    // which path earns, which crawler takes free, and what the missed money is made
    // of. `verdict` is narrowed against the known set, so an unknown value falls back
    // to "all" rather than silently matching nothing.
    app.get("/api/traffic", async (c) => {
      const now = Date.now();
      const windowMs = windowMsFromKey(c.req.query("window"));
      const observations = await readObservations();
      return c.json(
        buildTraffic(
          observations,
          { since: now - windowMs, verdict: parseVerdict(c.req.query("verdict")), q: c.req.query("q") },
          now,
        ),
      );
    });

    // The identity split, given its own surface: who signs, who doesn't, and who
    // presented a signature that failed — which is a masquerade, not a mistake.
    app.get("/api/agents", async (c) => {
      const now = Date.now();
      const windowMs = windowMsFromKey(c.req.query("window"));
      const observations = await readObservations();
      return c.json(buildAgents(observations, { since: now - windowMs, q: c.req.query("q") }, now));
    });

    // The operator's own records, back out. GET (a download, not a mutation) and
    // read-only, so it takes no CSRF guard; the Host allowlist and Basic auth are what
    // stand between it and anyone else, exactly as for /api/ops.
    app.get("/api/export", async (c) => {
      const now = Date.now();
      const windowMs = windowMsFromKey(c.req.query("window"));
      const since = now - windowMs;
      const kind = parseKind(c.req.query("kind"));
      const format = parseFormat(c.req.query("format"));

      const body =
        kind === "events"
          ? serializeEvents(
              (await sink.readAll()).filter((e) => e.at >= since).sort((a, b) => b.at - a.at),
              format,
            )
          : serializeObservations(
              (await readObservations()).filter((o) => o.at >= since).sort((a, b) => b.at - a.at),
              format,
            );

      c.header("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${exportFilename(kind, format, now)}"`);
      return c.body(body);
    });

    // Ops over SSE. The ledger already streamed while traffic polled, so the two
    // halves of the Overview moved on different clocks.
    app.get("/api/stream/ops", (c) => {
      const windowMs = windowMsFromKey(c.req.query("window"));
      return streamSSE(c, async (stream) => {
        const signal = { aborted: false };
        stream.onAbort(() => {
          signal.aborted = true;
        });
        for await (const snapshot of watchOps(readObservations, { signal, windowMs })) {
          if (stream.aborted) break;
          await stream.writeSSE({ event: "ops", data: JSON.stringify(snapshot) });
        }
      });
    });

    // The preflight. Read-only: reads loaded config and GETs addresses that came
    // from it. Never writes, spends, or settles.
    app.get("/api/doctor", async (c) => {
      const content = await readContent();
      const health = await gateHealth();
      return c.json(
        await runDoctor({
          health,
          restartPending: content.apiMode
            ? false
            : isRestartPending({
                fileModifiedAt: content.fileModifiedAt,
                gateStartedAt: health.startedAt ?? null,
                gateUp: health.up,
              }),
          accessMode: ACCESS.mode,
        }),
      );
    });

    // "Is it actually tolling?" — the gate is asked for one of its own tollable
    // articles with a crawler UA. State-changing only in the sense that it makes an
    // outbound request, so it takes the same CSRF guard as the write routes; the
    // target is built from GATE_URL, never from the request.
    app.post("/api/test-toll", auditWrite("console.test_toll"), sameOrigin, adminOnly, async (c) => {
      const config = await summarizeConfig();
      const slug = config.articles?.[0]?.slug ?? null;
      return c.json(await runTollProbe({ slug, apiMode: config.creditsSource.mode === "api" }));
    });

    app.get("/api/content", async (c) => {
      const content = await readContent();
      // Restart-drift: the gate loaded credits.json at boot, so an edit written
      // since then is on disk but not yet served. Surface it so the operator knows
      // to restart (and the console can pitch cloud's live-apply). API mode has no
      // local file, so no drift to report.
      if (content.apiMode) return c.json({ ...content, gate: { up: false }, restartPending: false });
      const health = await gateHealth();
      return c.json({
        ...content,
        gate: { up: health.up, startedAt: health.startedAt ?? null },
        restartPending: isRestartPending({
          fileModifiedAt: content.fileModifiedAt,
          gateStartedAt: health.startedAt ?? null,
          gateUp: health.up,
        }),
      });
    });

    app.post("/api/content/scan", auditWrite("console.content_scan"), sameOrigin, adminOnly, async (c) => {
      const body = await c.req.json<{ defaultWallet?: string }>().catch(() => ({}) as { defaultWallet?: string });
      try {
        return c.json(await scanArticles(body.defaultWallet?.trim() || undefined));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
    });

    // The crawler policy — the gate has always enforced it and the open core never let
    // anyone write one. Read projects the file over the curated registry; write validates
    // through shared's normalizer (including the humans-read-free guard) before it
    // persists, so the file the gate loads at boot is always one the validator passed.
    app.get("/api/crawlers", async (c) => {
      const view = await readCrawlers();
      const health = await gateHealth();
      return c.json({
        ...view,
        gate: { up: health.up, startedAt: health.startedAt ?? null },
        restartPending: isPolicyRestartPending({
          fileModifiedAt: view.fileModifiedAt,
          gateStartedAt: health.startedAt ?? null,
          gateUp: health.up,
        }),
      });
    });

    app.post("/api/crawlers", auditWrite("console.crawlers_write"), sameOrigin, adminOnly, async (c) => {
      const body = await c.req
        .json<{ allow?: unknown; block?: unknown; charge?: unknown }>()
        .catch(() => ({}) as { allow?: unknown; block?: unknown; charge?: unknown });
      const result = await writeCrawlers(body);
      return c.json(result, result.written ? 200 : 422);
    });

    // Webhooks — the settlement notifications the gate has always been able to send and has never
    // been able to show. Read-only by construction: endpoints come from NAULON_WEBHOOK_ENDPOINTS,
    // so there is nothing here to create or delete. Secrets are masked before they leave the
    // process, in every mode (this whole block is already non-public, but a whsec_ does not get to
    // depend on that).
    app.get("/api/webhooks", async (c) => {
      const view = await buildWebhooksView();
      const health = await gateHealth();
      // A queued delivery is sent by the GATE's sweep, not by the console. With the gate down,
      // pressing Send test ping would otherwise look like it did nothing.
      return c.json({ ...view, gate: { up: health.up } });
    });

    // Both writes below take the same CSRF guard as every other state-changing route, and both
    // resolve their target from the operator's own configuration — never from a URL in the request.
    app.post("/api/webhooks/ping", auditWrite("console.webhook_ping"), sameOrigin, adminOnly, async (c) => {
      const body = await c.req.json<{ endpointId?: unknown }>().catch(() => ({}) as { endpointId?: unknown });
      const endpointId = typeof body.endpointId === "string" ? body.endpointId : "";
      const result = await queuePing(endpointId);
      return c.json(result, result.ok ? 200 : 400);
    });

    app.post("/api/webhooks/resend", auditWrite("console.webhook_resend"), sameOrigin, adminOnly, async (c) => {
      const body = await c.req.json<{ deliveryId?: unknown }>().catch(() => ({}) as { deliveryId?: unknown });
      const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
      const result = await resendDelivery(deliveryId);
      return c.json(result, result.ok ? 200 : 400);
    });

    app.post("/api/content", auditWrite("console.content_write"), sameOrigin, adminOnly, async (c) => {
      const body = await c.req.json<{ credits?: Record<string, unknown> }>().catch(() => ({}) as { credits?: Record<string, unknown> });
      const result = await writeCredits(body.credits ?? {});
      return c.json(result, result.written ? 200 : 422);
    });
  }
}

export const port = cfg.DASHBOARD_PORT;
export const hostname = cfg.DASHBOARD_BIND;
export const access = ACCESS;
export const credential = CREDENTIAL;
export const consoleState = STORE ? { path: STATE_PATH, writable: STORE.writable, hasUsers: HAS_USERS } : null;
