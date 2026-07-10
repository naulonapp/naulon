/**
 * `@naulon/enforce/next` (re-exported as `@naulon/sdk/enforce/next`) — the
 * Next.js App Router middleware adapter.
 *
 * Next middleware is a pre-filter: return a `Response` to short-circuit (402/403),
 * or `NextResponse.next()` to let the route render. The one thing that needs the
 * `next` package is `NextResponse.next()` — so we INJECT `NextResponse` rather
 * than importing `next/server`, keeping the gate free of a hard `next` dependency
 * (the publisher's app already has it). Everything else is the framework-agnostic
 * core.
 *
 *   // middleware.ts (in the publisher's Next app)
 *   import { NextResponse } from "next/server";
 *   import { createNaulonMiddleware } from "@naulon/sdk/enforce/next";
 *   export const middleware = createNaulonMiddleware({ …opts }, NextResponse);
 *   export const config = { matcher: ["/essays/:path*"] };
 */
import { naulonMiddleware, type NaulonMiddlewareOptions } from "./middleware.ts";

/** The slice of `NextResponse` this adapter uses (the real class satisfies it). */
export interface NextResponseLike {
  next(): Response;
}

export function createNaulonMiddleware(
  opts: NaulonMiddlewareOptions,
  NextResponse: NextResponseLike,
): (req: Request) => Promise<Response> {
  const core = naulonMiddleware(opts);
  return async (req: Request): Promise<Response> => {
    const { response, setHeaders } = await core(req);
    if (response) return response; // short-circuit (402 / 403)
    // Pass to the route, carrying the paid receipt headers onto the continuation.
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(setHeaders ?? {})) res.headers.set(k, v);
    return res;
  };
}
