/**
 * Express credits route — the same minimal `CreditsResolver` framing as the Next
 * adapter (`../next/credits-route.ts`), wrapped for an Express `(req, res)` route.
 * Pins the one thing publishers get wrong: `404 = free read`, distinct from a
 * `200` with credits. Wire it as:
 *   app.get("/api/credits/:slug", createExpressCreditsRoute(resolver));
 */
import { createCreditsRoute } from "../next/credits-route.ts";
import type { CreditsResolver } from "../resolver/types.ts";
import { type ExpressHandler, headerValue, pipeResponse } from "./_bridge.ts";

export function createExpressCreditsRoute(
  resolver: CreditsResolver,
  opts?: { token?: string },
): ExpressHandler {
  const handler = createCreditsRoute(resolver, opts);
  return async (req, res) => {
    const slug = req.params.slug ?? "";
    const headers = new Headers();
    const auth = headerValue(req.headers["authorization"]);
    if (auth !== undefined) headers.set("authorization", auth);
    const request = new Request(`http://credits.local/${encodeURIComponent(slug)}`, { headers });
    const response = await handler(request, { params: Promise.resolve({ slug }) });
    await pipeResponse(response, res);
  };
}
