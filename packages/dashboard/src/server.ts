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
 * Access is decided ONCE at boot (see access.ts): loopback → private ops; wide +
 * DASHBOARD_AUTH → ops behind Basic; DASHBOARD_PUBLIC → earnings-only, masked;
 * wide + neither → refuse (don't leak wallets). That decision drives everything.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { basicAuth } from "hono/basic-auth";
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
import { runTollProbe } from "./test-toll.ts";
import { decideAccess } from "./access.ts";
import { isAllowedHost, parseAllowedHosts } from "./host-guard.ts";
import { tileSvg } from "./brand.ts";
import { RECENT_LIMIT } from "./constants.ts";

const cfg = getConfig();
const sink = getSink();
const PUBLIC = new URL("./public/", import.meta.url);

const ACCESS = decideAccess({
  bind: cfg.DASHBOARD_BIND,
  auth: cfg.DASHBOARD_AUTH,
  isPublic: cfg.DASHBOARD_PUBLIC,
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
      "/doctor": { file: "doctor.html", type: "text/html; charset=utf-8" },
      "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
      "/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
      "/overview.js": { file: "overview.js", type: "text/javascript; charset=utf-8" },
      "/requests.js": { file: "requests.js", type: "text/javascript; charset=utf-8" },
      "/agents.js": { file: "agents.js", type: "text/javascript; charset=utf-8" },
      "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
      "/content.js": { file: "content.js", type: "text/javascript; charset=utf-8" },
      "/crawlers.js": { file: "crawlers.js", type: "text/javascript; charset=utf-8" },
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
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      // Inherited from default-src, but stated so the "we ship our own faces, we
      // never reach a CDN" decision is legible to anyone auditing the header.
      "font-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

// DNS-rebinding guard — before anything reads or renders. Private mode runs without
// auth, so the Host allowlist is the only thing that stops a page the operator visits
// from re-pointing its own hostname at 127.0.0.1 and reading the ops API same-origin.
// See host-guard.ts for the full shape.
const ALLOWED_HOSTS = parseAllowedHosts(cfg.DASHBOARD_ALLOWED_HOSTS);
app.use("*", async (c, next) => {
  if (!isAllowedHost(c.req.header("Host"), ALLOWED_HOSTS, ACCESS.mode)) {
    // The Host is echoed so the operator can see WHICH value was refused (a proxy
    // sending an unexpected name is the whole failure mode). It is attacker-controlled,
    // so it stays in a text/plain body under the nosniff + CSP set above — never
    // interpolated into HTML.
    return c.text(
      `naulon dashboard: refusing a request for Host "${c.req.header("Host") ?? "(absent)"}".\n\n` +
        `The private console has no authentication, so it answers only to loopback\n` +
        `hostnames. If you reach it through a reverse proxy, add that hostname to\n` +
        `DASHBOARD_ALLOWED_HOSTS (comma-separated).\n`,
      403,
    );
  }
  await next();
});

// Fail safe: bound wide with no auth and not public → serve nothing but the reason.
if (ACCESS.refuse) {
  app.all("*", (c) => c.text(`naulon dashboard refused to start serving.\n\n${ACCESS.reason}\n`, 503));
} else {
  if (ACCESS.requireAuth) {
    const [username, password] = (cfg.DASHBOARD_AUTH ?? "").split(/:(.*)/s);
    app.use("*", basicAuth({ username: username ?? "", password: password ?? "" }));
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
    const sameOrigin = async (c: import("hono").Context, next: () => Promise<void>) => {
      const host = c.req.header("Host");
      const source = c.req.header("Origin") ?? c.req.header("Referer");
      if (source) {
        let sourceHost: string;
        try {
          sourceHost = new URL(source).host;
        } catch {
          return c.text("malformed Origin/Referer", 403);
        }
        if (sourceHost !== host) return c.text("cross-origin request refused", 403);
      }
      await next();
    };

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
    app.post("/api/test-toll", sameOrigin, async (c) => {
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

    app.post("/api/content/scan", sameOrigin, async (c) => {
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

    app.post("/api/crawlers", sameOrigin, async (c) => {
      const body = await c.req
        .json<{ allow?: unknown; block?: unknown; charge?: unknown }>()
        .catch(() => ({}) as { allow?: unknown; block?: unknown; charge?: unknown });
      const result = await writeCrawlers(body);
      return c.json(result, result.written ? 200 : 422);
    });

    app.post("/api/content", sameOrigin, async (c) => {
      const body = await c.req.json<{ credits?: Record<string, unknown> }>().catch(() => ({}) as { credits?: Record<string, unknown> });
      const result = await writeCredits(body.credits ?? {});
      return c.json(result, result.written ? 200 : 422);
    });
  }
}

export const port = cfg.DASHBOARD_PORT;
export const hostname = cfg.DASHBOARD_BIND;
export const access = ACCESS;
