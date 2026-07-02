/**
 * Earnings dashboard — a real-time view of authors earning USDC as machines pay
 * to read and cite their work. The traction proof, and the centerpiece of the
 * demo. Reads the shared event ledger; updates live over SSE.
 */
import { serve } from "@hono/node-server";
import { app, port, hostname } from "./server.ts";

serve({ fetch: app.fetch, port, hostname });
console.log(`🜉 earnings dashboard on http://${hostname}:${port}`);
