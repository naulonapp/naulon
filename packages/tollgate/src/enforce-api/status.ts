/**
 * `GET /_naulon/enforce-status`: confirms a key works, and says whether the gate behind it is
 * self-hosted.
 *
 * Runtimes call it to check a key before saving it. A hosted control plane can answer it with a
 * per-host health report of its own instead; this route is what a gate with no such report serves,
 * so a runtime pointed at a self-hosted gate gets a definite answer rather than a 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

const StatusSchema = z
  .object({ hosts: z.array(z.looseObject({})), attention: z.boolean(), selfHosted: z.boolean() })
  .openapi("EnforcementStatus");

const statusRoute = createRoute({
  method: "get",
  path: "/_naulon/enforce-status",
  summary: "Check a key and whether the gate is self-hosted",
  tags: ["Enforce"],
  security: SECURITY,
  responses: {
    200: { description: "The key works.", content: { "application/json": { schema: StatusSchema } } },
    401: { description: "Missing or invalid key.", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function mountStatus(app: OpenAPIHono, deps: EnforceApiDeps): void {
  app.openapi(statusRoute, async (c) => {
    const auth = await deps.auth(c, null);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    return c.json({ hosts: [], attention: false, selfHosted: auth.selfHosted }, 200);
  });
}
