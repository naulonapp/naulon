/**
 * `GET /_naulon/enforce-status`: confirms a key works, and says whether the gate behind it is
 * self-hosted.
 *
 * Runtimes call it to check a key before saving it. A hosted control plane can answer it with a
 * per-host health report of its own instead; this route is what a gate with no such report serves,
 * so a runtime pointed at a self-hosted gate gets a definite answer rather than a 404.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { targetOf } from "./authorize.ts";
import type { EnforceApiDeps } from "./index.ts";
import { ErrorSchema, SECURITY } from "./schemas.ts";

/** The route, built per mount so a host can document its own per-host rows. */
function statusRoute(docs: EnforceApiDeps["docs"]) {
  const Row = docs?.statusRow ?? z.looseObject({});
  const StatusSchema = z.object({ hosts: z.array(Row), attention: z.boolean(), selfHosted: z.boolean() }).openapi("EnforcementStatus");
  return createRoute({
    method: "get",
    path: "/_naulon/enforce-status",
    summary: docs?.statusSummary ?? "Check a key and whether the gate is self-hosted",
    tags: ["Enforce"],
    security: SECURITY,
    request: {
      query: z.object({
        resource: z.string().optional().openapi({ description: "Your site's address. Lets a gate that issues per-site keys tell whose key this is." }),
      }),
    },
    responses: {
      200: { description: "The key works.", content: { "application/json": { schema: StatusSchema } } },
      401: { description: "Missing or invalid key.", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "The key does not serve this site.", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
}

export function mountStatus(app: OpenAPIHono, deps: EnforceApiDeps): void {
  app.openapi(statusRoute(deps.docs), async (c) => {
    const target = targetOf(c.req.query("resource"));
    const auth = await deps.auth(c, "host" in target ? target.host : null);
    if (!auth.ok) return ("response" in auth ? auth.response : c.json({ error: auth.error }, auth.status)) as never;
    const report = deps.hooks?.statusReport ? await deps.hooks.statusReport(auth.publisherId) : { hosts: [], attention: false };
    return c.json({ ...report, selfHosted: auth.selfHosted }, 200);
  });
}
