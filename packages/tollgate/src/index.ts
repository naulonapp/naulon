/**
 * Tollgate — Node entrypoint. Runs the Hono `app` (defined in app.ts) under
 * @hono/node-server for local dev and any long-running host (a VPS, Fly, the
 * docker-compose stack). For serverless (Vercel) see api/index.ts, which wraps
 * the same `app`.
 */
import { serve } from "@hono/node-server";
import { getConfig } from "@naulon/shared";
import { app } from "./app.ts";
import { startSettlementDrain } from "./settlementSink.ts";

const cfg = getConfig();
serve({ fetch: app.fetch, port: cfg.TOLLGATE_PORT });
console.log(`🜉 tollgate listening on :${cfg.TOLLGATE_PORT} → proxying ${cfg.ORIGIN_URL}`);

// Crash-safe at-least-once delivery of settlement events to the publisher
// ledger: a boot sweep recovers anything stranded by a restart, then a periodic
// sweep catches transient IA outages. No-op when the emit is dark.
startSettlementDrain();
