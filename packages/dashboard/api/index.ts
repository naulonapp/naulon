/**
 * Vercel function entrypoint for the earnings dashboard.
 *
 * Wraps the same Hono `app` as the Node server in src/index.ts (defined in
 * src/server.ts). The Node runtime is required: the dashboard streams live
 * updates over Server-Sent Events.
 *
 * On Vercel, point it at the same Supabase project as the tollgate
 * (EVENTS_BACKEND=supabase) so it reads the very ledger the gate writes. See
 * DEPLOY.md. This serverless build is configured but not yet exercised live.
 */
import { handle } from "hono/vercel";
import { app } from "../src/server.ts";

export const config = { runtime: "nodejs" };

export default handle(app);
