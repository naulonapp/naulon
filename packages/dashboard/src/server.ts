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
import { summarizeOps } from "./ops.ts";
import { summarizeConfig } from "./config-view.ts";
import { readObservations } from "./observations.ts";
import { readContent, scanArticles, writeCredits } from "./content.ts";
import { decideAccess } from "./access.ts";
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
      "/ledger.css": { file: "ledger.css", type: "text/css; charset=utf-8" },
      "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
    }
  : {
      "/": { file: "index.html", type: "text/html; charset=utf-8" },
      "/ledger": { file: "ledger.html", type: "text/html; charset=utf-8" },
      "/content": { file: "content.html", type: "text/html; charset=utf-8" },
      "/ledger.css": { file: "ledger.css", type: "text/css; charset=utf-8" },
      "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
      "/ops.js": { file: "ops.js", type: "text/javascript; charset=utf-8" },
      "/content.js": { file: "content.js", type: "text/javascript; charset=utf-8" },
    };

const maskWallet = (w: string): string => (w.length > 12 ? w.slice(0, 6) + "…" + w.slice(-4) : w);
const maskLedger = (l: Ledger): Ledger => ({
  ...l,
  authors: l.authors.map((a) => ({ ...a, wallet: maskWallet(a.wallet) })),
  recent: l.recent.map((c) => ({ ...c, payer: maskWallet(c.payer) })),
});
const ledgerFor = (l: Ledger): Ledger => (isPublic ? maskLedger(l) : l);

async function gateHealth(): Promise<{ up: boolean; service?: string; detail?: string }> {
  const url = cfg.GATE_URL.replace(/\/$/, "") + "/healthz";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false, detail: `HTTP ${r.status}` };
    const j = (await r.json()) as { ok?: boolean; service?: string };
    return { up: j.ok === true, service: j.service };
  } catch (e) {
    // A throw here always means we couldn't reach the gate — surface that plainly
    // rather than Node's opaque "fetch failed".
    return { up: false, detail: (e as Error).name === "TimeoutError" ? "timed out" : "unreachable" };
  }
}

export const app = new Hono();

// Security headers on every response (strict CSP: all assets same-origin).
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
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
    app.get("/api/ops", async (c) => {
      const now = Date.now();
      const [health, observations, config] = await Promise.all([
        gateHealth(),
        readObservations(),
        summarizeConfig(),
      ]);
      return c.json({ at: now, health, ops: summarizeOps(observations, now), config });
    });

    app.get("/api/content", async (c) => c.json(await readContent()));

    // State-changing routes: reject cross-origin (Basic-auth browsers auto-send
    // creds, so a same-origin check is the CSRF guard on this money-write surface).
    const sameOrigin = async (c: import("hono").Context, next: () => Promise<void>) => {
      const origin = c.req.header("Origin");
      const host = c.req.header("Host");
      if (origin && new URL(origin).host !== host) return c.text("cross-origin request refused", 403);
      await next();
    };

    app.post("/api/content/scan", sameOrigin, async (c) => {
      const body = await c.req.json<{ defaultWallet?: string }>().catch(() => ({}) as { defaultWallet?: string });
      try {
        return c.json(await scanArticles(body.defaultWallet?.trim() || undefined));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
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
