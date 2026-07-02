/**
 * Vercel function entrypoint for the tollgate.
 *
 * Wraps the same Hono `app` as the Node server in src/index.ts — the route logic
 * lives in src/app.ts and neither entry forks it. `hono/vercel`'s `handle` adapts
 * Hono's fetch handler to a Vercel function; the Node runtime is required because
 * the gate streams the upstream response body through.
 *
 * On Vercel the gate has no shared disk and runs many instances, so deploy it with
 * EVENTS_BACKEND=supabase and NONCE_BACKEND=supabase (+ a fixed TOLLGATE_SECRET).
 * See DEPLOY.md. Note: this serverless build is configured but not yet exercised
 * live — the offline (Node) path is the tested one.
 */
import { handle } from "hono/vercel";
import { app } from "../src/app.ts";

export const config = { runtime: "nodejs" };

export default handle(app);
