/**
 * Operator dashboard — the self-host window onto the gate: health, live toll
 * traffic (served-free / denied / paid), settlement earnings, and config sanity.
 * Reads the gate's observation + event logs; the public earnings view is opt-in.
 */
import { serve } from "@hono/node-server";
import { app, port, hostname, access, credential } from "./server.ts";

serve({ fetch: app.fetch, port, hostname });

const where = `http://${hostname}:${port}`;
if (access.refuse) {
  console.warn(`🜉 dashboard bound ${hostname} but REFUSING to serve — ${access.reason}`);
} else {
  console.log(`🜉 naulon dashboard [${access.mode}] on ${where}`);
  if (credential && !credential.hashed) {
    // Deprecation, not a refusal: an operator who upgrades must not find their console
    // dark. It stops being accepted in a later release, and the line says so each boot.
    console.warn(
      "🜉 DASHBOARD_AUTH holds the password in the clear, so it is readable in .env, in\n" +
        "   your deploy secret store and in `docker inspect`. Mint a hash instead:\n" +
        "     npm run hash -w @naulon/dashboard -- --user <name>\n" +
        "   Plaintext will stop being accepted in a future release.",
    );
  }
}
