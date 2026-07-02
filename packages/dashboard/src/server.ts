/**
 * Dashboard server — serves the earnings view and streams live updates.
 *
 *   GET /            the interface (single self-contained page)
 *   GET /api/ledger  the current aggregate
 *   GET /api/stream  Server-Sent Events: a ledger snapshot, then a push every
 *                    time a new attributed event lands in the ledger file
 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getConfig, getSink } from "@naulon/shared";
import { aggregate } from "./aggregate.ts";

const sink = getSink();
const INDEX = new URL("./public/index.html", import.meta.url).pathname;

export const app = new Hono();

app.get("/", async (c) => c.html(await readFile(INDEX, "utf8")));

app.get("/api/ledger", async (c) => c.json(aggregate(await sink.readAll())));

app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    let lastCount = -1;
    // Push an immediate snapshot, then poll for newly-settled crossings.
    while (!stream.aborted) {
      const events = await sink.readAll();
      if (events.length !== lastCount) {
        lastCount = events.length;
        await stream.writeSSE({ event: "ledger", data: JSON.stringify(aggregate(events)) });
      }
      await stream.sleep(1000);
    }
  }),
);

export const port = getConfig().DASHBOARD_PORT;
// Localhost by default — the earnings view is read-only but unauthenticated and
// shows author wallets + USD. Bind wider only behind your own auth.
export const hostname = getConfig().DASHBOARD_BIND;
