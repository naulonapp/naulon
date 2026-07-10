/**
 * `withNaulon` — wrap any web fetch handler (Cloudflare Workers, Netlify/Deno
 * Edge, a Hono/`itty` route, a bare `export default { fetch }`) with the toll.
 *
 * Unlike the Next adapter (a pre-filter that returns `next()`), a fetch handler
 * IS the thing that produces the page — so on a pass we CALL the wrapped handler
 * and stamp the paid-receipt headers onto its response. On a refusal (402/403) we
 * short-circuit and never invoke the handler.
 */
import { naulonMiddleware, type NaulonMiddlewareOptions } from "./middleware.ts";

export function withNaulon(
  handler: (req: Request) => Promise<Response> | Response,
  opts: NaulonMiddlewareOptions,
): (req: Request) => Promise<Response> {
  const core = naulonMiddleware(opts);
  return async (req: Request): Promise<Response> => {
    const { response, setHeaders } = await core(req);
    if (response) return response; // 402 / 403 — never reach the handler
    const res = await handler(req);
    if (setHeaders) {
      for (const [k, v] of Object.entries(setHeaders)) res.headers.set(k, v);
    }
    return res;
  };
}
