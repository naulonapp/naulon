/**
 * Operator dashboard — the self-host window onto the gate: health, live toll
 * traffic (served-free / denied / paid), settlement earnings, and config sanity.
 * Reads the gate's observation + event logs; the public earnings view is opt-in.
 */
import { serve } from "@hono/node-server";
import { app, port, hostname, access, credential, consoleState, seededAdmin } from "./server.ts";

serve({ fetch: app.fetch, port, hostname });

const where = `http://${hostname}:${port}`;
if (access.refuse) {
  console.warn(`🜉 dashboard bound ${hostname} but REFUSING to serve — ${access.reason}`);
} else {
  console.log(`🜉 naulon dashboard [${access.mode}] on ${where}`);
  if (consoleState) {
    if (!consoleState.hasUsers) {
      // The single most useful line for someone who just upgraded: the console still works
      // exactly as it did, and here is the one action that turns real sign-in on.
      console.log(
        `\u{1F709} no console accounts yet — create the first administrator at ${where}/setup` +
          (credential ? " (DASHBOARD_AUTH keeps working until you do)" : ""),
      );
    }
    if (!consoleState.writable) {
      console.warn(
        `\u{1F709} ${consoleState.path} is not writable — console sign-in is unavailable here.\n` +
          "   Serverless and read-only filesystems can only use the DASHBOARD_AUTH machine credential.",
      );
    }
    if (seededAdmin && !seededAdmin.ok) {
      console.warn(`\u{1F709} CONSOLE_ADMIN_PASSWORD was not applied — ${seededAdmin.error}`);
    }
  }
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
