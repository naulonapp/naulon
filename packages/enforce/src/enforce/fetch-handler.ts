/**
 * `withNaulon` — wrap any web fetch handler (Cloudflare Workers, Netlify/Deno
 * Edge, a Hono/`itty` route, a bare `export default { fetch }`) with the toll.
 *
 * Unlike the Next adapter (a pre-filter that returns `next()`), a fetch handler
 * IS the thing that produces the page — so on a pass we CALL the wrapped handler
 * and stamp the paid-receipt headers onto its response. On a refusal (402/403) we
 * short-circuit and never invoke the handler.
 */
import { naulonMiddleware, type MiddlewareResult, type NaulonMiddlewareOptions } from "./middleware.ts";

/** A built toll: `naulonMiddleware(opts)` for one site, or `naulonSites(opts)` for a platform. */
export type NaulonCore = (req: Request) => Promise<MiddlewareResult>;

export function coreOf(opts: NaulonMiddlewareOptions | NaulonCore): NaulonCore {
  return typeof opts === "function" ? opts : naulonMiddleware(opts);
}

export function withNaulon(
  handler: (req: Request) => Promise<Response> | Response,
  opts: NaulonMiddlewareOptions | NaulonCore,
): (req: Request) => Promise<Response> {
  const core = coreOf(opts);
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
