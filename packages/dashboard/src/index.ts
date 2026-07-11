/**
 * Operator dashboard — the self-host window onto the gate: health, live toll
 * traffic (served-free / denied / paid), settlement earnings, and config sanity.
 * Reads the gate's observation + event logs; the public earnings view is opt-in.
 */
import { serve } from "@hono/node-server";
import { app, port, hostname, access } from "./server.ts";

serve({ fetch: app.fetch, port, hostname });

const where = `http://${hostname}:${port}`;
if (access.refuse) {
  console.warn(`🜉 dashboard bound ${hostname} but REFUSING to serve — ${access.reason}`);
} else {
  console.log(`🜉 naulon dashboard [${access.mode}] on ${where}`);
}
