/**
 * Dashboard server — serves the earnings view and streams live updates.
 *
 *   GET /            the interface (index.html)
 *   GET /ledger.css  · GET /ledger.js   the view's style + behaviour
 *   GET /api/ledger  the current aggregate (one-shot JSON)
 *   GET /api/stream  Server-Sent Events: a snapshot, then a push each time the
 *                    ledger changes (see watchLedger)
 *
 * The page is split into html/css/js (all same-origin, no CDN), which lets the
 * Content-Security-Policy stay strict — no 'unsafe-inline' anywhere.
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getConfig, getSink } from "@naulon/shared";
import { aggregate } from "./aggregate.ts";
import { watchLedger } from "./watch.ts";
import { RECENT_LIMIT } from "./constants.ts";

const sink = getSink();
const PUBLIC = new URL("./public/", import.meta.url);

// Three small static files, served by explicit route so we own the exact
// Content-Type. No framework static handler, no directory traversal surface.
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ledger.css": { file: "ledger.css", type: "text/css; charset=utf-8" },
  "/ledger.js": { file: "ledger.js", type: "text/javascript; charset=utf-8" },
};

export const app = new Hono();

// Security headers on every response. The page reaches no off-origin resource
// (styles, scripts, fonts are all same-origin), so default-src 'self' holds;
// data: is allowed only for the inline SVG favicon.
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

for (const [path, asset] of Object.entries(ASSETS)) {
  app.get(path, async (c) => {
    c.header("Content-Type", asset.type);
    return c.body(await readFile(new URL(asset.file, PUBLIC), "utf8"));
  });
}

app.get("/api/ledger", async (c) => c.json(aggregate(await sink.readAll(), RECENT_LIMIT)));

app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    const signal = { aborted: false };
    stream.onAbort(() => {
      signal.aborted = true;
    });
    for await (const led of watchLedger(sink, { signal })) {
      if (stream.aborted) break;
      await stream.writeSSE({ event: "ledger", data: JSON.stringify(led) });
    }
  }),
);

export const port = getConfig().DASHBOARD_PORT;
// Localhost by default — the earnings view is read-only but unauthenticated and
// shows author wallets + USD. Bind wider only behind your own auth.
export const hostname = getConfig().DASHBOARD_BIND;
