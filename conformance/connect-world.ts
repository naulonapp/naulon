/**
 * A self-hosted gate and its console on loopback, for connect conformance runs in any language:
 * the real token and revocation endpoints, the real approve page and the real enforce API, sharing
 * one in-memory state store as the two processes share one store in production. The owner is
 * already signed in as an administrator; everything else is the code that ships.
 *
 * In-process: `const w = await startConnectWorld(); ...; await w.close();`
 *
 * As a process, for a runtime written in another language:
 *
 *   node --import tsx conformance/connect-world.ts
 *
 * prints one line, `naulon-world {"gate":"http://127.0.0.1:…","console":"http://127.0.0.1:…"}`, and runs
 * until its stdin closes. The Python suite drives it this way (`tests/test_connect_e2e.py`).
 */
import { serve, type ServerType } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { clientResolver, memoryStateStore, type GateStateStore, type PublisherConfig } from "@naulon/shared";
import { mountConnectApprove } from "../packages/dashboard/src/connect-approve.ts";
import { mountEnforceApi } from "../packages/tollgate/src/enforce-api/index.ts";
import { siteCredentialAuth } from "../packages/tollgate/src/connect/auth.ts";
import { mountGateConnect } from "../packages/tollgate/src/connect/routes.ts";

export interface ConnectWorld {
  state: GateStateStore;
  origins: { gate: string; console: string };
  close(): Promise<void>;
}

async function listen(app: { fetch: (req: Request) => Response | Promise<Response> }): Promise<{ origin: string; server: ServerType }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ origin: `http://127.0.0.1:${info.port}`, server }));
  });
}

const closeServer = (s: ServerType) => new Promise<void>((r) => s.close(() => r()));

/** Every host is one publisher. Enough for the enforce API to answer `enforce-status` and refuse a
 *  credential on a host it was not approved for; pricing is not what this world tests. */
const resolver = { resolve: async () => ({ id: "default" }) as PublisherConfig };

export async function startConnectWorld(o: { state?: GateStateStore } = {}): Promise<ConnectWorld> {
  const state = o.state ?? memoryStateStore();

  // The gate's issuer is its own origin, known only once it listens, so it listens first and its
  // routes are mounted behind the socket. The console stamps the same issuer on its redirects.
  const gateApp = new OpenAPIHono();
  const gateSrv = await listen({ fetch: (req) => gateApp.fetch(req) });

  const consoleApp = new Hono();
  consoleApp.use("*", async (c, next) => {
    c.set("naulonPrincipal" as never, { kind: "session", username: "owner", userId: "u1", role: "admin", mustChangePassword: false } as never);
    await next();
  });
  mountConnectApprove(consoleApp, { state, clients: clientResolver({ allowPrivate: true }), allowPrivate: true, gateLabel: "the test gate", issuer: gateSrv.origin });
  const consoleSrv = await listen(consoleApp);

  mountGateConnect(gateApp as unknown as Hono, { state, issuer: gateSrv.origin, authorizeUrl: `${consoleSrv.origin}/connect/authorize` });
  mountEnforceApi(gateApp, { resolver, auth: siteCredentialAuth({ state, resolver }), observe: () => {} });

  return {
    state,
    origins: { gate: gateSrv.origin, console: consoleSrv.origin },
    close: async () => {
      await Promise.all([closeServer(consoleSrv.server), closeServer(gateSrv.server)]);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await startConnectWorld();
  process.stdout.write(`naulon-world ${JSON.stringify(w.origins)}\n`);
  process.stdin.resume();
  process.stdin.on("end", () => void w.close().then(() => process.exit(0)));
}
